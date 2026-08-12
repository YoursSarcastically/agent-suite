/**
 * Agent runtime.
 *
 * Everything here runs in the browser. There is no server and no API key.
 *
 * The central design decision: WebLLM's OpenAI-style function calling is still
 * marked work-in-progress upstream, and small models are unreliable at emitting
 * well-formed tool calls from a prose instruction. What WebLLM *does* do well is
 * grammar-constrained JSON generation - the schema is enforced during decoding
 * in the WASM layer, so malformed JSON is not merely unlikely, it is unreachable.
 *
 * So tools are not "called". Every agent declares a JSON Schema for its output,
 * and the runtime constrains decoding to that schema. Tool dispatch becomes a
 * pure function of a guaranteed-valid object. That trades a little expressiveness
 * for the thing that actually matters at 1.5B: never having to parse a maybe-JSON
 * blob out of a chatty response.
 */

import * as webllm from "https://esm.run/@mlc-ai/web-llm";

/** Small enough to download once and run on an integrated GPU. */
export const DEFAULT_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

/** Larger fallback for machines that can afford it. */
export const MODELS = [
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 1.5B", vram: "~1.1 GB" },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B", vram: "~2.3 GB" },
  { id: "Qwen2.5-7B-Instruct-q4f16_1-MLC", label: "Qwen2.5 7B", vram: "~5.1 GB" },
];

let enginePromise = null;
let activeModel = null;

/**
 * WebGPU is the hard requirement. Fail loudly and early rather than throwing
 * something inscrutable from deep inside the WASM loader.
 */
export function checkSupport() {
  if (!navigator.gpu) {
    return {
      ok: false,
      reason:
        "WebGPU is not available. Use Chrome or Edge 113+, or Safari 18+. " +
        "Firefox needs dom.webgpu.enabled set in about:config.",
    };
  }
  return { ok: true };
}

/**
 * Load a model. The first call downloads weights into the browser's cache
 * (hundreds of MB), so progress is reported rather than left to a spinner.
 */
export async function getEngine(modelId = DEFAULT_MODEL, onProgress = () => {}) {
  const support = checkSupport();
  if (!support.ok) throw new Error(support.reason);

  if (enginePromise && activeModel === modelId) return enginePromise;

  activeModel = modelId;
  enginePromise = webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (p) => onProgress(p.progress ?? 0, p.text ?? ""),
  });
  return enginePromise;
}

/**
 * Run one agent.
 *
 * Returns the parsed object plus timing. Latency is surfaced per call because
 * on-device inference has a very different cost curve from an API - the first
 * token is slow, and throughput depends entirely on the user's hardware. An
 * agent that is pleasant at 40 tok/s is unusable at 4, and you only find that
 * out by measuring on real machines.
 */
export async function runAgent(agent, input, opts = {}) {
  const {
    modelId = DEFAULT_MODEL,
    onProgress = () => {},
    onToken = null,
    signal = null,
  } = opts;

  const engine = await getEngine(modelId, onProgress);
  const started = performance.now();

  const messages = [
    { role: "system", content: agent.system },
    { role: "user", content: agent.buildPrompt(input) },
  ];

  const request = {
    messages,
    temperature: agent.temperature ?? 0,
    max_tokens: agent.maxTokens ?? 512,
    // The schema is enforced during decoding, not validated afterwards.
    response_format: { type: "json_object", schema: JSON.stringify(agent.schema) },
  };

  let raw = "";
  if (onToken) {
    const stream = await engine.chat.completions.create({ ...request, stream: true });
    for await (const chunk of stream) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      raw += delta;
      if (delta) onToken(delta);
    }
  } else {
    const reply = await engine.chat.completions.create(request);
    raw = reply.choices?.[0]?.message?.content ?? "";
  }

  const elapsedMs = performance.now() - started;

  // Grammar constraints make this parse safe in practice, but a truncated
  // generation (max_tokens hit mid-object) is still possible, so it is handled.
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Model returned unparseable output - likely truncated at max_tokens=${
        agent.maxTokens ?? 512
      }. Raw: ${raw.slice(0, 200)}`
    );
  }

  const { value, repairs } = normalize(data, agent.schema);

  return {
    data: value,
    repairs,
    raw,
    elapsedMs,
    tokensPerSecond: estimateTps(raw, elapsedMs),
    model: modelId,
  };
}

/**
 * Constrained decoding enforces *shape*, not *semantics*.
 *
 * This is the sharpest edge of the whole approach and it is easy to miss: the
 * grammar guarantees `confidence` is a number and `priority` is one of four
 * strings, but it will happily emit `confidence: 9` against a field documented
 * as 0-1. JSON Schema's `minimum`/`maximum` are assertions, and the decoder
 * only implements the structural subset.
 *
 * So numeric ranges are clamped here, after the fact. Every repair is reported
 * rather than applied silently - a model that constantly needs clamping is
 * telling you the prompt is wrong, and swallowing that signal would hide it.
 */
export function normalize(obj, schema) {
  const repairs = [];

  const walk = (node, spec) => {
    if (!spec || node == null) return node;

    if (spec.type === "object" && spec.properties) {
      for (const [key, sub] of Object.entries(spec.properties)) {
        if (key in node) node[key] = walk(node[key], sub);
      }
      return node;
    }

    if (spec.type === "array" && Array.isArray(node)) {
      return node.map((item) => walk(item, spec.items));
    }

    if (spec.type === "number" || spec.type === "integer") {
      let n = typeof node === "number" ? node : Number(node);
      if (!Number.isFinite(n)) return node;
      const before = n;
      if (typeof spec.minimum === "number") n = Math.max(spec.minimum, n);
      if (typeof spec.maximum === "number") n = Math.min(spec.maximum, n);
      if (spec.type === "integer") n = Math.round(n);
      if (n !== before) repairs.push({ from: before, to: n, range: [spec.minimum, spec.maximum] });
      return n;
    }

    return node;
  };

  return { value: walk(obj, schema), repairs };
}

function estimateTps(text, ms) {
  if (!ms) return 0;
  // ~4 chars per token is close enough for a UI readout.
  return Math.round((text.length / 4 / ms) * 1000);
}

/** Free GPU memory when switching models. */
export async function unload() {
  if (!enginePromise) return;
  try {
    const engine = await enginePromise;
    await engine.unload();
  } finally {
    enginePromise = null;
    activeModel = null;
  }
}
