/**
 * The agent loop.
 *
 * Everything in this project already rests on one idea: WebLLM's function
 * calling is work-in-progress upstream and small models are bad at emitting
 * well-formed tool calls from a prose instruction, but grammar-constrained
 * JSON generation is enforced in the WASM layer during decoding. So instead of
 * asking a 1.5B model to *call* a tool, we ask it to *choose* one - and we make
 * the choice an enum.
 *
 * That is the whole trick here. `next_tool` is a closed set. The model cannot
 * hallucinate a tool that does not exist, cannot misspell one, cannot wrap it in
 * prose, and cannot emit malformed arguments, because none of those states are
 * reachable under the grammar. Tool dispatch stops being parsing and becomes a
 * switch statement over a guaranteed-valid string.
 *
 * The argument is a single string, deliberately. Structured argument objects are
 * exactly the nested schemas that hang the constrained decoder at this model
 * size (see the README), so a tool that needs structure parses it itself.
 */

import { runAgent } from "./runtime.js";

/** How many steps before we stop, regardless of what the planner wants. */
const DEFAULT_MAX_STEPS = 6;

/**
 * Build the planner for a specific tool set.
 *
 * The planner is generated per-loop rather than declared once, because the enum
 * of legal tools *is* the tool list. A tool that is not in this array is not
 * merely discouraged - it is unrepresentable in the output.
 */
function plannerFor(tools, goal) {
  const names = [...tools.map((t) => t.name), "finish"];

  return {
    id: "planner",
    temperature: 0,
    maxTokens: 320,
    system:
      "You are the planner for a small agent. You pick exactly one next step at a time. " +
      "Look at what has already been observed and choose the tool that makes progress. " +
      "Never repeat a tool that has already produced a good observation. " +
      "Choose 'finish' as soon as the goal is met - stopping early is better than padding.",
    schema: {
      type: "object",
      properties: {
        next_tool: {
          type: "string",
          enum: names,
          description: "The single next step",
        },
        argument: {
          type: "string",
          description: "Input for that tool. Empty string when the tool needs none.",
        },
        reason: { type: "string", description: "One short sentence: why this step, now" },
      },
      required: ["next_tool", "argument", "reason"],
    },
    buildPrompt: (scratchpad) =>
      `GOAL:\n${goal}\n\nTOOLS:\n${tools
        .map((t) => `- ${t.name}: ${t.description}`)
        .join("\n")}\n- finish: the goal is met, stop\n\n` +
      `WHAT HAS HAPPENED SO FAR:\n${scratchpad || "(nothing yet - this is the first step)"}\n\n` +
      `Choose the single next step.`,
  };
}

/**
 * Run a goal to completion.
 *
 * `onStep` fires for every decision and every observation, because the loop is
 * the interesting part of these apps and hiding it behind a spinner would waste
 * the one thing an on-device agent can afford to show: all of its working.
 */
export async function runLoop({
  goal,
  tools,
  maxSteps = DEFAULT_MAX_STEPS,
  modelId,
  signal = null,
  onStep = () => {},
  context = {},
}) {
  const planner = plannerFor(tools, goal);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const transcript = [];
  const results = {};
  // Small planners loop. Told a tool produced nothing, they will often reach for
  // the same tool with the same argument rather than trying a different one, so
  // repeats are refused here instead of being paid for in GPU time.
  const attempted = new Set();

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) break;

    const scratchpad = transcript
      .map((t, i) => `${i + 1}. ${t.tool}(${t.argument || ""}) -> ${t.summary}`)
      .join("\n");

    const decision = await runAgent(planner, scratchpad, { modelId, signal });
    const { next_tool, argument, reason } = decision.data;

    if (next_tool === "finish") {
      onStep({ kind: "finish", reason, step });
      break;
    }

    const tool = byName.get(next_tool);
    if (!tool) {
      // Unreachable under the grammar, but a decoder that has been asked for an
      // enum it cannot satisfy will emit *something*, so the loop does not
      // assume its own guarantees hold.
      onStep({ kind: "error", tool: next_tool, message: "planner chose an unknown tool", step });
      break;
    }

    const fingerprint = `${next_tool}:${argument}`;
    if (attempted.has(fingerprint)) {
      transcript.push({
        tool: next_tool,
        argument,
        summary: "SKIPPED - this exact call was already made. Try a different tool or argument.",
      });
      onStep({ kind: "repeat", tool: next_tool, argument, step });
      continue;
    }
    attempted.add(fingerprint);

    onStep({ kind: "plan", tool: next_tool, argument, reason, step });

    try {
      const observation = await tool.run(argument, { ...context, results, signal, modelId });
      results[next_tool] = observation;
      const summary = tool.summarize ? tool.summarize(observation) : brief(observation);
      transcript.push({ tool: next_tool, argument, summary });
      onStep({ kind: "observation", tool: next_tool, observation, summary, step });

      // A tool that produces the answer ends the run. Without this the planner
      // will happily re-derive an answer it already has, and every extra lap
      // costs a full generation.
      if (tool.terminal) {
        onStep({ kind: "finish", reason: `${next_tool} produced the answer`, step });
        break;
      }
    } catch (err) {
      if (err.name === "AbortError") break;
      transcript.push({ tool: next_tool, argument, summary: `failed: ${err.message}` });
      onStep({ kind: "error", tool: next_tool, message: err.message, step });
    }
  }

  return { results, transcript };
}

/** A one-line rendering of any observation, for the planner's scratchpad. */
function brief(value) {
  if (value == null) return "nothing";
  if (typeof value === "string") return truncate(value, 220);
  if (Array.isArray(value)) return `${value.length} items: ${truncate(JSON.stringify(value), 220)}`;
  return truncate(JSON.stringify(value), 260);
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
