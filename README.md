# Agent Suite

**Four small apps that run entirely in your browser.** No API key, no account, no server, no bill — and they keep working with the wifi off.

### ▶ [Open it](https://yourssarcastically.github.io/agent-suite/) · [Run the evals](https://yourssarcastically.github.io/agent-suite/evals/run.html)

Needs a WebGPU browser (Chrome/Edge 113+, Safari 18+). First load downloads ~1.1 GB of weights into your browser cache; after that it is instant and works offline.

---

## The apps

| | | |
|---|---|---|
| 🧠 **Braindump** | Type the way your head actually works. Get a real list back. | One agent extracts, another commits to what you do next |
| 📚 **The Pile** | Everything you saved and never read, now it answers questions. | Agent loop over your own shelf |
| 📓 **Journal** | Write freely. It files the mood, the people, the promises. | May decline to find a pattern, and often should |
| 🎬 **Recommend Me** | Describe a mood, get films, shows and books. | The only app that uses the network — and it says so |

Plus **[Under the hood](https://yourssarcastically.github.io/agent-suite/#workbench)** — the twelve raw agents everything is assembled from, with the schema-constrained JSON on screen.

---

## Why the browser

Every "AI agent" demo has the same shape: a thin UI in front of somebody's API. That makes three problems invisible, and hides one capability.

**Cost per call is invisible.** When inference is free at the margin, you stop asking whether an agent should run. That sounds like a downside until you notice what it permits: The Pile reads your entire shelf on every question rather than an index of it, Journal re-reads every entry you have ever written to look for a pattern, and Recommend Me can throw away a set of search results it does not like and go again with different words. Each of those is a feature a metered product would have to ration.

**Latency is somebody else's problem.** An API call has roughly constant latency. On-device, throughput depends entirely on the machine, and the same agent is pleasant at 40 tok/s and unusable at 4. You only learn this by shipping onto hardware you do not control, so the suite names the GPU it found and reports tokens per second on every run.

**The data question never gets asked.** These are the things you would least want to paste anywhere: your todo list, your journal, everything you saved to read later — a fairly complete picture of what you are doing, worrying about, and curious about. "It never leaves the device" is a different product from "we don't train on your data", and only one of them survives a security review.

---

## The architecture decision: schemas, not function calls

WebLLM's OpenAI-style function calling is still marked work-in-progress upstream, and small models are poor at emitting well-formed tool calls from a prose instruction. What WebLLM *does* do well is **grammar-constrained JSON generation** — the schema is enforced during decoding in the WASM layer, so malformed JSON is not merely unlikely, it is unreachable.

So nothing here "calls a tool". Every agent declares a JSON Schema, decoding is constrained to it, and dispatch becomes a pure function of a guaranteed-valid object.

**That is also how the agent loop works.** When an app plans its next step, `next_tool` is an enum of the tools that actually exist:

```js
schema: {
  properties: {
    next_tool: { type: "string", enum: [...toolNames, "finish"] },
    argument:  { type: "string" },
    reason:    { type: "string" },
  },
}
```

The model cannot hallucinate a tool, misspell one, or wrap it in prose, because none of those states are reachable under the grammar. Tool dispatch stops being parsing and becomes a switch statement.

The argument is a single string, deliberately — structured argument objects are exactly the nested schemas that hang the decoder, which is the next section.

**Enums beat free text at 1.5B.** A small model asked for a "priority" will cheerfully invent `"medium-high"`. Constrained decoding turns the enum from a hopeful instruction into a hard guarantee.

---

## What building it actually taught me

**Constrained decoding enforces shape, not semantics.** This one cost me an hour. The grammar guarantees `confidence` is a number and `priority` is one of four strings — and then happily emits `confidence: 9` for a field documented as 0–1. JSON Schema's `minimum`/`maximum` are *assertions*; the decoder implements the structural subset only.

The fix is a normalization pass that clamps numerics to their declared range **and reports every repair** rather than applying it silently. A model that constantly needs clamping is telling you the prompt is wrong, and swallowing that signal hides it.

**Nested object schemas hang the decoder outright.** Not "are slower" — hang. The two agents that originally emitted `array<object>` (`redact`, `actions`) never returned; an eval run stalled indefinitely on the first one while flat-schema agents were finishing in ~4s. The engine serializes requests, so one stuck generation blocks everything behind it.

Flattening `{type, value}[]` into two index-aligned arrays fixed it — the same agent completes in 9.4s. **But the fix is not free.** Parallel arrays have no structural guarantee they stay the same length, and the very first run after the change proved it:

```json
{ "finding_types":  ["phone", "email"],
  "finding_values": ["marcus.webb@example.com"] }
```

Two types, one value. A nested schema would have made that state unrepresentable. So the real tradeoff is: *nested schemas are correct-by-construction but do not generate; flat schemas generate but push the correctness burden into validation.*

**And then I did not actually do the validation.** The paragraph above shipped in this README describing a failure mode, and the code checked ranges and nothing else — no alignment check anywhere, for months. Meanwhile the eval suite carried `expect_finding_types`, a checker still reading `got.findings`, the nested shape deleted when `redact` was flattened. It could only ever fail. No golden case used it, which is exactly why it survived.

Both are fixed now. Agents declare their invariants (`aligned`, `derived`), `runtime.validate()` enforces them after decoding, the apps surface breakage instead of silently dropping a row, and misaligned outputs are a scoreboard number in the eval run. The lesson is not "add validation" — it is that a README describing a bug is not the same as a test catching it, and prose is much better at hiding the gap.

**Refusal is the hard part, and it cuts both ways.** The golden set tracks refusal cases separately, because a suite that is 90% green while every refusal case fails describes an agent that is confidently wrong — worse than one that is uncertainly right. But tuning *for* refusal produces the opposite failure: an agent that abstains too often is one users stop consulting. Both directions are in the suite deliberately.

This matters most in Journal, which can return `found: false` when asked for a pattern. A fabricated insight about a support ticket is an annoyance; a fabricated insight about someone's own life is a small harm, so declining is a first-class outcome rather than a fallback.

**Small models cannot recall, so never ask them to.** Recommend Me is built entirely around this. Ask a 1.5B model to name films and it invents them — right shape, right era, plausible director, does not exist. So the model never names a title. It turns a mood into search phrases (rewriting, which it is good at), three real catalogues return real titles, and the model ranks and explains what came back (reading, also good at). Everything on screen came from a database, not from the weights.

---

## Measured, on a 2-core Apple GPU

`evals/apps.html` runs each app's real agent chain and reports latency per call.
The golden set asks whether an agent classifies correctly; this asks whether the
app is usable, which is a different question — an agent can be accurate and
still make an app painful, because the app runs three of them while you wait.

Two 3B models, same machine, same code:

| | **Llama 3.2 3B** | Qwen2.5 3B |
|---|---|---|
| Checks passed | **9 / 9** | 8 / 9 |
| Whole suite | **95s** | 113s |
| Braindump | 30.4s | 31.9s |
| Journal | **19.0s** | 25.5s |
| The Pile | **25.3s** | 37.4s |
| Recommend Me | 20.3s | **18.5s** |
| Median tok/s | 9 | 9 |
| Download | **2.21 GB** | 2.45 GB |

Llama 3.2 3B is the default on those numbers: a clean sweep, 19% faster, and
240MB smaller. Qwen2.5 3B's one failure was semantic rather than mechanical — it
offered a film to someone who asked for a book, which is the kind of mistake no
schema can prevent.

Qwen2.5 1.5B is kept as the small option and it is genuinely worse, in a way
that shows up as product quality rather than as a failed assertion: asked for
"something like Nope but funnier" it searches for `funnier` and `Nope`, where
the 3B searches for `horror comedy` and `sci-fi comedy`. No amount of prompting
closed that gap.

**Earlier, before the ranking agent was rewritten**, Llama scored 8/9 and took
134s — the extra 39 seconds were a single agent generating until `max_tokens`
and then failing to parse:

### What is actually runnable

A model needs three things to run here, and the third is the one that catches
people out: MLC-converted weights, a matching **WebGPU wasm binary**, and an
entry in WebLLM's prebuilt config. Weights alone are not enough.

| | MLC weights | WebGPU wasm | Runs in WebLLM |
|---|---|---|---|
| Gemma 4 E4B | ✗ | ✗ | no |
| Gemma 3 4B | ✓ | ✗ | **no** |
| Gemma 3 1B | ✓ | ✓ | yes — 0.69 GB |
| Gemma 2 2B | ✓ | ✓ | yes — 1.85 GB |
| Llama 3.2 3B | ✓ | ✓ | yes — 2.21 GB |

Gemma 4 (July 2026) is the obvious thing to want here — Per-Layer Embeddings
are designed for exactly this, 4.5B effective parameters from 8B total — and it
has not been converted to MLC at all. Gemma 3 4B *has* been converted and still
will not run: `mlc-ai/gemma-3-4b-it-q4f16_1-MLC` exists, but no
`gemma-3-4b-*-webgpu.wasm` does, so there is nothing for the browser to load.
Compiling one is possible through MLC-LLM and is a real piece of work, not a
config change.

### Newer models stall, and they all stall identically

Every model newer than Llama 3.2 and Qwen2.5 that will load here fails the same
way, and it is the one failure grammar-constrained decoding is supposed to make
impossible: **a generation that cannot be parsed.**

| | Result |
|---|---|
| Qwen3 1.7B | 900 tokens of newlines in 103s, then unparseable |
| Gemma 3 1B | 1/9 app checks passed; 6 lost to the same stall |

Both emit a valid partial object and then produce nothing but whitespace:

```
{"tasks": ["ship the deck", "get the invoice from ben", "cancel the gym"]
                    ⏎ ⏎ ⏎ ⏎ ⏎ …  until max_tokens
```

My first explanation was Qwen3's `<think>` block having nowhere to go under a
grammar. **That was wrong.** Gemma 3 has no reasoning mode and fails the same
way, and Qwen3's own `/no_think` switch changed nothing in either the system
prompt or the last user turn — both measured.

The likelier cause is structural. Whitespace is legal between any two tokens of
a JSON document, and emitting it *does not advance the parser*. So when the
model's preferred continuation is masked out by the grammar, whitespace is the
highest-probability legal token, and taking it leaves the model in exactly the
state it was already in — there is no gradient back towards finishing. Older
models were tuned hard on strict JSON and rarely land there. Newer ones are
tuned for reasoning traces, markdown and conversational hedging, all of which
the grammar masks, and the fallback is a whitespace loop.

That fix belongs in the decoder — forbidding or penalising unbounded whitespace
runs — not in application code. Until then, newer is not better here.

Gemma 3 1B also needed a config correction just to start: WebLLM's own prebuilt
record sets `context_window_size: 4096` on a sliding-window model, and the
engine then refuses it, insisting on exactly one of the two. Models can now
carry a `chatOpts` override for that class of problem.

## Layout## Layout

```
src/runtime.js      engine, constrained generation, normalization, validation
src/orchestrator.js the agent loop; next_tool as an enum
src/agents.js       the original twelve declarative agent records
src/app-agents.js   agents specific to the six apps
src/catalog.js      the only file that touches the network, and it logs every request
src/apps/*.js       one file per app
evals/goldens.json  golden set, refusal cases tagged
evals/run.js        assertion-based runner
evals/apps.js       app-level latency and accuracy
```

## Evals

`evals/goldens.json` asserts on **fields, not prose** — the decisions a downstream system acts on. Prose quality is not asserted at all; it varies run to run and produces a suite that fails for no reason and gets ignored.

```
open https://yourssarcastically.github.io/agent-suite/evals/run.html
```

Results are reported honestly, including the failures. Scores differ by machine and model, which is itself the point: an eval that only ran on my laptop tells you nothing about yours.

## Running locally

No build step, no dependencies, no bundler. It is ES modules and a static server:

```bash
python3 serve.py
```

Then open `http://localhost:8777`. Deployment is the same story — static files on GitHub Pages with a `.nojekyll` and nothing else.

---

## A note on the one network call

Five of the six apps make no requests at all once the weights are cached. **Recommend Me does**, because it looks up real titles in [iTunes Search](https://performance-partners.apple.com/search-api), [TVMaze](https://www.tvmaze.com/api) and [Open Library](https://openlibrary.org/developers/api) — none of which need an API key, which is why this is still a static site with no backend and no secret to leak.

The app shows every URL it requested, in the UI, as it happens — including the ones that failed and why. The honest claim there is narrower than for the rest: your taste never leaves the tab, only the search words do.

Being unauthenticated has a cost worth knowing about: iTunes allows roughly twenty calls a minute and TVMaze twenty per ten seconds, and a single mood fanning out across three queries and two catalogues will trip both. Requests are queued behind a minimum gap and retried once on a rate limit. OMDb and TMDB would avoid this, but both require an API key, and a key committed to a static site is a key anyone can take.

---

Built by [YoursSarcastically](https://github.com/YoursSarcastically) · inference by [WebLLM](https://github.com/mlc-ai/web-llm)
