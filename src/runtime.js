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
 * pure function of a guaranteed-valid object - which is what makes the desk in
 * pipeline.js possible at all: one station can feed the next only because the
 * thing coming out of the first is guaranteed to have the shape the second reads.
 */

import * as webllm from "https://esm.run/@mlc-ai/web-llm";

/**
 * Models.
 *
 * Llama 3.2 3B is the default because it is the one that measurably works.
 * `evals/apps.html` scores it 8/9 on the app suite at ~10 tok/s; Qwen2.5 1.5B
 * passes fewer and, more visibly, cannot follow "give me genre keywords, not
 * words from my sentence" however the prompt is written - it answers "something
 * like Nope but funnier" with the search terms `funnier` and `Nope`, where the
 * 3B answers `horror comedy` and `sci-fi comedy`.
 *
 * Every model newer than these stalls, and they all stall the same way.
 *
 * Qwen3 1.7B and Gemma 3 1B both emit a valid partial object and then produce
 * nothing but newlines until max_tokens - 900 tokens of whitespace in 103
 * seconds for Qwen3, 6 of 9 app evals lost the same way for Gemma 3. A
 * grammar-constrained generation that cannot be parsed is the one outcome the
 * whole approach is supposed to make unreachable.
 *
 * The first guess was Qwen3's <think> block having nowhere to go under a
 * grammar. That was wrong: Gemma 3 has no reasoning mode and fails identically,
 * and `/no_think` changed nothing in either the system prompt or the user turn.
 *
 * The likelier cause is structural. Whitespace is legal between any two tokens
 * of a JSON document, and emitting it does not advance the parser. So whenever
 * the model's preferred continuation is masked out by the grammar, whitespace
 * is the highest-probability *legal* token available, and taking it changes
 * nothing about the state it is in - there is no gradient back towards
 * finishing. Older instruction-tuned models were tuned hard on emitting strict
 * JSON and rarely land in that hole. Newer ones are tuned for reasoning traces,
 * markdown and conversational hedging, all of which the grammar masks, and the
 * fallback is a whitespace loop.
 *
 * The fix belongs in the decoder - forbidding unbounded whitespace runs, or
 * penalising them - not in this file. Until then, newer is not better here, and
 * a picker option that always fails is worse than one that is missing.
 */
export const DEFAULT_MODEL = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

export const MODELS = [
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 1.5B", vram: "~1.6 GB" },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B", vram: "~2.2 GB" },
  { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", label: "Qwen2.5 3B", vram: "~2.5 GB" },
];

/**
 * How much room the browser will actually give this origin.
 *
 * WebLLM caches weights and never evicts an old model, so trying four of them
 * fills the quota and every subsequent load dies on
 * `Failed to execute 'add' on 'Cache'` - which says nothing about the real
 * cause. Checking first turns an opaque stall into a sentence and a button.
 */
export async function storageReport(neededBytes = 0) {
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota, free: Math.max(0, quota - usage), enough: quota - usage >= neededBytes };
  } catch {
    return { usage: 0, quota: 0, free: Infinity, enough: true };
  }
}

/** Drop every cached model. The only way back from a full quota. */
export async function clearModelCache() {
  let removed = 0;
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith("webllm")) { await caches.delete(name); removed++; }
    }
  } catch { /* storage denied */ }
  return removed;
}

let enginePromise = null;
let activeModel = null;
let usingWorker = true;

/* ------------------------------------------------------------------ *
 * device
 * ------------------------------------------------------------------ */

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
 * Name the hardware. The whole premise is that throughput depends on a machine
 * nobody controls, so "it runs at 40 tok/s" is meaningless without saying on what.
 * `adapter.info` is the current spelling, `requestAdapterInfo()` the older one,
 * and some browsers still ship neither.
 */
export async function describeDevice() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return { label: "Unknown GPU" };
    const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
    const parts = [info.vendor, info.architecture].filter(Boolean);
    return { label: info.description || parts.join(" ") || "your GPU" };
  } catch {
    return { label: "your GPU" };
  }
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
  // Some prebuilt records ship a config the engine will not accept; a model may
  // carry the correction with it rather than the caller having to know.
  const chatOpts = MODELS.find((m) => m.id === modelId)?.chatOpts;
  const config = { initProgressCallback: (p) => onProgress(p.progress ?? 0, p.text ?? "") };

  enginePromise = createEngine(modelId, config, chatOpts);
  return enginePromise;
}

/**
 * Prefer a worker; fall back to the main thread.
 *
 * The worker is the whole point - see src/worker.js - but it is not guaranteed
 * to exist. Module workers need a same-origin script URL, so anything opening
 * this from a file:// URL, or a browser without module-worker support, has to
 * keep working rather than showing a blank page. The fallback is the old
 * behaviour: correct, and janky while it generates.
 */
async function createEngine(modelId, config, chatOpts) {
  try {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    return await webllm.CreateWebWorkerMLCEngine(worker, modelId, config, chatOpts);
  } catch (err) {
    console.warn("Worker engine unavailable, running on the main thread:", err.message);
    usingWorker = false;
    return webllm.CreateMLCEngine(modelId, config, chatOpts);
  }
}

export const isLoaded = () => Boolean(enginePromise);
export const loadedModel = () => activeModel;
/** False when the worker could not start and inference is blocking the page. */
export const isOffMainThread = () => usingWorker;

/**
 * Stop the current generation without tearing the engine down.
 *
 * This is not a nicety. The engine serialises requests, so one long generation
 * blocks everything queued behind it - on a slow GPU a 7B run can leave the page
 * looking hung with no way out but a reload.
 */
export async function interrupt() {
  if (!enginePromise) return;
  try {
    (await enginePromise).interruptGenerate();
  } catch {
    /* nothing in flight */
  }
}

/* ------------------------------------------------------------------ *
 * generation
 * ------------------------------------------------------------------ */

/**
 * Run one agent.
 *
 * Latency is surfaced per call because on-device inference has a very different
 * cost curve from an API - the first token is slow, and throughput depends
 * entirely on the user's hardware. An agent that is pleasant at 40 tok/s is
 * unusable at 4, and you only find that out by measuring on real machines.
 */
export async function runAgent(agent, input, opts = {}) {
  const {
    modelId = DEFAULT_MODEL,
    onProgress = () => {},
    onToken = null,
    signal = null,
    seed,
  } = opts;

  const engine = await getEngine(modelId, onProgress);
  const started = performance.now();

  const request = {
    messages: [
      { role: "system", content: agent.system },
      { role: "user", content: agent.buildPrompt(input) },
    ],
    temperature: agent.temperature ?? 0,
    max_tokens: agent.maxTokens ?? 512,
    // The schema is enforced during decoding, not validated afterwards.
    response_format: { type: "json_object", schema: JSON.stringify(agent.schema) },
  };
  if (typeof seed === "number") request.seed = seed;

  let raw = "";
  let completionTokens = 0;

  if (onToken) {
    const stream = await engine.chat.completions.create({
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const chunk of stream) {
      if (signal?.aborted) {
        await interrupt();
        throw new DOMException("Aborted", "AbortError");
      }
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        raw += delta;
        onToken(delta, raw);
      }
      if (chunk.usage?.completion_tokens) completionTokens = chunk.usage.completion_tokens;
    }
  } else {
    const reply = await engine.chat.completions.create(request);
    raw = reply.choices?.[0]?.message?.content ?? "";
    completionTokens = reply.usage?.completion_tokens ?? 0;
  }

  const elapsedMs = performance.now() - started;

  // Grammar constraints make this parse safe in practice, but a truncated
  // generation (max_tokens hit mid-object) is still possible, so it is handled.
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Grammar-constrained output is always well-formed *so far*; the only way it
    // fails to parse is running out of room mid-object. Say that, rather than
    // showing someone a truncated JSON fragment and the word "unparseable".
    const err = new Error(
      "The model ran out of room before it finished. Try a shorter input."
    );
    err.truncated = true;
    err.raw = raw;
    console.warn(`[${agent.id}] truncated at max_tokens=${agent.maxTokens ?? 512}:`, raw.slice(0, 400));
    throw err;
  }

  const { value, repairs } = normalize(data, agent.schema);
  // Report the breakage first, then repair it. Reversing these would hide the
  // signal that the prompt is producing malformed tables in the first place.
  const issues = validate(value, agent);
  const realigned = realign(value, agent);

  return {
    data: value,
    repairs,
    realigned,
    issues,
    raw,
    elapsedMs,
    // Real counts when the engine reports them; ~4 chars/token when it does not.
    completionTokens: completionTokens || Math.round(raw.length / 4),
    tokensPerSecond: tps(completionTokens || raw.length / 4, elapsedMs),
    model: modelId,
  };
}

/* ------------------------------------------------------------------ *
 * validation
 * ------------------------------------------------------------------ */

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

  const walk = (node, spec, path = "") => {
    if (!spec || node == null) return node;

    if (spec.type === "object" && spec.properties) {
      for (const [key, sub] of Object.entries(spec.properties)) {
        if (key in node) node[key] = walk(node[key], sub, path ? `${path}.${key}` : key);
      }
      return node;
    }

    if (spec.type === "array" && Array.isArray(node)) {
      return node.map((item, i) => walk(item, spec.items, `${path}[${i}]`));
    }

    if (spec.type === "number" || spec.type === "integer") {
      let n = typeof node === "number" ? node : Number(node);
      if (!Number.isFinite(n)) return node;
      const before = n;
      if (typeof spec.minimum === "number") n = Math.max(spec.minimum, n);
      if (typeof spec.maximum === "number") n = Math.min(spec.maximum, n);
      if (spec.type === "integer") n = Math.round(n);
      if (n !== before) {
        repairs.push({ field: path, from: before, to: n, range: [spec.minimum, spec.maximum] });
      }
      return n;
    }

    return node;
  };

  return { value: walk(obj, schema), repairs };
}

/**
 * The checks a JSON Schema cannot express.
 *
 * Nested object schemas hang the constrained decoder at this model size, so the
 * two agents that wanted `{type, value}[]` emit index-aligned parallel arrays
 * instead. The README is honest about that trade and says the correctness burden
 * moves into validation - and then nothing actually validated it. This is the
 * missing half. It is not hypothetical: the first run after flattening `redact`
 * produced two finding types and one finding value.
 *
 * `derived` covers the same class of problem one level up. A field documented as
 * "how many of these are unassigned" is a claim about another field, and a
 * grammar has no way to hold a model to it.
 */
export function validate(data, agent) {
  const issues = [];

  for (const group of agent.aligned ?? []) {
    const lengths = group.map((key) => (Array.isArray(data[key]) ? data[key].length : null));
    if (lengths.some((n) => n === null)) continue;
    if (new Set(lengths).size > 1) {
      issues.push({
        kind: "misaligned",
        fields: group,
        detail: group.map((key, i) => `${key}: ${lengths[i]}`).join(" · "),
        message:
          "These arrays are index-aligned by convention only. A nested schema would have " +
          "made this state unrepresentable — a flat one has to catch it here.",
      });
    }
  }

  for (const [countField, spec] of Object.entries(agent.derived ?? {})) {
    const source = data[spec.from];
    if (!Array.isArray(source) || typeof data[countField] !== "number") continue;
    const actual = source.filter((v) => v === spec.equals).length;
    if (actual !== data[countField]) {
      issues.push({
        kind: "inconsistent",
        fields: [countField, spec.from],
        detail: `said ${data[countField]} · actually ${actual}`,
        message: "The model reported a count that disagrees with the array it counts.",
      });
    }
  }

  return issues;
}

/**
 * Repair misaligned parallel arrays instead of merely reporting them.
 *
 * Detecting the breakage was not enough, and the first real run said so. Asked
 * for five tasks the model returned five of everything except `owners`, where
 * it collapsed five identical "me" values into one - deduplicating a column of
 * a table it did not know was a table. Truncating every array to the shortest
 * one turned five real tasks into one, which is a far worse outcome than the
 * misalignment itself.
 *
 * So an agent names a `spine` - the array that defines the true row count - and
 * a `fill` value per column. Short columns are padded, long ones trimmed, and
 * every repair is reported. The rows survive; the guarantee a nested schema
 * would have given for free is reconstructed here, visibly, at the cost of
 * having to declare a default for every field.
 */
export function realign(data, agent) {
  const repairs = [];
  if (!agent.spine) return repairs;

  for (const group of agent.aligned ?? []) {
    if (!group.includes(agent.spine)) continue;
    const rows = Array.isArray(data[agent.spine]) ? data[agent.spine].length : 0;
    if (!rows) continue;

    for (const key of group) {
      if (key === agent.spine || !Array.isArray(data[key])) continue;
      const had = data[key].length;
      if (had === rows) continue;

      if (had < rows) {
        const filler = agent.fill?.[key] ?? "";
        // Repeat the single value when the model gave exactly one - it almost
        // always means "the same for every row", which is why it deduplicated.
        const pad = had === 1 ? data[key][0] : filler;
        data[key] = [...data[key], ...Array(rows - had).fill(pad)];
      } else {
        data[key] = data[key].slice(0, rows);
      }
      repairs.push({ field: key, from: had, to: rows });
    }
  }

  return repairs;
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const tps = (tokens, ms) => (ms ? Math.round((tokens / ms) * 1000) : 0);

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
