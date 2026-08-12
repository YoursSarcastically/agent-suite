# Agent Suite

**Twelve AI agents that run entirely in your browser.** No API key, no server, no data leaving the tab.

### ▶ [Try it live](https://yourssarcastically.github.io/agent-suite/) · [Run the evals](https://yourssarcastically.github.io/agent-suite/evals/run.html)

Needs a WebGPU browser (Chrome/Edge 113+, Safari 18+). First load downloads ~1.1 GB of weights into your browser cache; after that it is instant and works offline.

---

## Why in-browser

Every "AI agent" demo has the same shape: a thin UI in front of somebody's API. That makes three problems invisible.

**Cost per call is invisible.** When inference is free at the margin, you stop asking whether an agent should run on every keystroke. Running on-device makes the budget physical — it is the user's battery and their GPU.

**Latency is somebody else's problem.** An API call has roughly constant latency. On-device, throughput depends entirely on the machine, and the same agent is pleasant at 40 tok/s and unusable at 4. You only learn this by shipping it onto hardware you do not control.

**The data question never gets asked.** Support inboxes are full of names, addresses, and card numbers. "It never leaves the device" is a different product from "we don't train on your data", and only one of them survives a security review.

This suite makes all three unavoidable, which is the point.

---

## The architecture decision: schemas, not function calls

WebLLM's OpenAI-style function calling is still marked work-in-progress upstream, and small models are poor at emitting well-formed tool calls from a prose instruction. What WebLLM *does* do well is **grammar-constrained JSON generation** — the schema is enforced during decoding in the WASM layer, so malformed JSON is not merely unlikely, it is unreachable.

So nothing here "calls a tool". Every agent declares a JSON Schema, decoding is constrained to it, and dispatch becomes a pure function of a guaranteed-valid object:

```js
{
  id: "triage",
  system: "You triage inbound support messages…",
  schema: {
    type: "object",
    properties: {
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["priority", "confidence"],
  },
  buildPrompt: (input) => `Triage this message:\n\n${input}`,
}
```

Adding a thirteenth agent means adding one object to an array. There is no runtime to modify — all the variability lives in the schema.

**Enums beat free text at 1.5B.** A small model asked for a "priority" will cheerfully invent `"medium-high"`. Constrained decoding turns the enum from a hopeful instruction into a hard guarantee.

---

## What building it actually taught me

**Constrained decoding enforces shape, not semantics.** This one cost me an hour. The grammar guarantees `confidence` is a number and `priority` is one of four strings — and then happily emits `confidence: 9` for a field documented as 0–1. JSON Schema's `minimum`/`maximum` are *assertions*; the decoder implements the structural subset only.

The fix is a normalization pass that clamps numerics to their declared range **and reports every repair** rather than applying it silently. A model that constantly needs clamping is telling you the prompt is wrong, and swallowing that signal hides it. The UI shows a ⚠ when a value was clamped.

**Refusal is the hard part, and it cuts both ways.** The golden set tracks refusal cases separately from everything else, because a suite that is 90% green while every refusal case fails describes an agent that is confidently wrong — worse than one that is uncertainly right.

But tuning *for* refusal produces the opposite failure. `draft-reply` fails a case where the context genuinely does support an answer and it refuses anyway. Over-refusal is a real product cost: an agent that abstains too often is one users stop consulting. Both directions are in the suite deliberately.

**Nested object schemas hang the decoder outright.** Not "are slower" — hang. The two agents that originally emitted `array<object>` (`redact`, `actions`) never returned; an eval run stalled indefinitely on the first one while flat-schema agents were finishing in ~4s. The engine serializes requests, so one stuck generation blocks everything behind it.

Flattening `{type, value}[]` into two index-aligned arrays fixed it — the same agent completes in 9.4s. **But the fix is not free, and pretending otherwise would be the wrong lesson.** Parallel arrays have no structural guarantee they stay the same length, and the very first run after the change proved it:

```json
{ "finding_types":  ["phone", "email"],
  "finding_values": ["marcus.webb@example.com"] }
```

Two types, one value. A nested schema would have made that state unrepresentable. So the real tradeoff is: *nested schemas are correct-by-construction but do not generate; flat schemas generate but push the correctness burden into validation.* At this model size only one of those options actually runs, so the burden moves to validation — but it does not disappear, and a consumer of these agents has to handle the misaligned case.

---

## The twelve

| Agent | Does | Notable field |
|---|---|---|
| 📥 Triage | Category, priority, owning team | `confidence` drives auto-route vs. queue |
| 🔍 Extract | Entities out of unstructured text | Empty arrays when nothing is present |
| 📝 Summarize | Thread → points, decisions, open questions | Separates decided from undecided |
| ✍ Draft Reply | Grounded reply, or an explicit refusal | `grounded: false` is a success |
| 🎭 Tone Shift | Rewrite to a target tone | `facts_preserved` guards meaning drift |
| 🌡 Sentiment & Risk | Emotional read + churn risk | Frustration ≠ intent to leave |
| 🔀 Intent Router | Message → downstream workflow | Falls back to `human_review` under 0.6 |
| 🔐 Redact | Finds personal data, emits safe text | Typed findings, not a regex sweep |
| ⚖ QA Scorer | Grades a reply against the question | Catches the polite non-answer |
| 🕳 Knowledge Gap | Can the KB answer at all? | Names the article that should exist |
| 🌐 Translate | Translate, preserve register | Leaves product names alone |
| ✅ Action Items | Commitments with owners | `unassigned` beats a guessed owner |

---

## Evals

`evals/goldens.json` asserts on **fields, not prose** — the decisions a downstream system acts on. Prose quality is not asserted at all; it varies run to run and produces a suite that fails for no reason and gets ignored.

```
open https://yourssarcastically.github.io/agent-suite/evals/run.html
```

Results are reported honestly, including the failures — see the run page for the current numbers on your own hardware. Scores differ by machine and model, which is itself the point: an eval that only ran on my laptop tells you nothing about yours.

---

## Running locally

No build step, no dependencies, no bundler. It is ES modules and a static server:

```bash
python3 serve.py
```

Then open `http://localhost:8777`.

Deployment is the same story — the whole thing is static files, which is why it hosts on GitHub Pages with a `.nojekyll` and nothing else.

---

## Layout

```
src/runtime.js    engine, constrained generation, numeric normalization
src/agents.js     twelve declarative agent records
src/ui.js         workbench
evals/goldens.json  golden set, refusal cases tagged
evals/run.js      assertion-based runner
```

---

Built by [YoursSarcastically](https://github.com/YoursSarcastically) · inference by [WebLLM](https://github.com/mlc-ai/web-llm)
