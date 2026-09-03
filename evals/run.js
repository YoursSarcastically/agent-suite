/**
 * Eval runner.
 *
 * Deliberately assertion-based rather than LLM-judged. The golden set checks
 * specific fields - did triage say "billing", did draft-reply refuse - because
 * those are the decisions the downstream system acts on. Prose quality is not
 * asserted at all; it varies run to run and asserting on it produces a suite
 * that fails for no reason and gets ignored.
 *
 * Refusal cases are counted separately. A suite that is 90% green while every
 * refusal case fails describes an agent that is confidently wrong, which is
 * worse than one that is uncertainly right.
 */

import { AGENTS, byId } from "../src/agents.js";
import { MODELS, DEFAULT_MODEL, getEngine, runAgent } from "../src/runtime.js";

const $ = (id) => document.getElementById(id);

MODELS.forEach((m) => {
  const o = document.createElement("option");
  o.value = m.id;
  o.textContent = m.label;
  if (m.id === DEFAULT_MODEL) o.selected = true;
  $("model").append(o);
});

/** Each checker returns null on pass, or a human-readable reason on fail. */
const CHECKS = {
  expect: (got, want) =>
    Object.entries(want)
      .filter(([k, v]) => got[k] !== v)
      .map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`),

  expect_one_of: (got, want) =>
    Object.entries(want)
      .filter(([k, vs]) => !vs.includes(got[k]))
      .map(([k, vs]) => `${k}: expected one of ${vs.join("|")}, got ${JSON.stringify(got[k])}`),

  expect_contains: (got, want) =>
    Object.entries(want)
      .filter(([k, needle]) => !JSON.stringify(got[k] ?? "").includes(needle))
      .map(([k, needle]) => `${k}: expected to contain "${needle}", got ${JSON.stringify(got[k])}`),

  expect_empty: (got, keys) =>
    keys.filter((k) => (got[k] ?? []).length !== 0).map((k) => `${k}: expected empty, got ${JSON.stringify(got[k])}`),

  expect_max: (got, want) =>
    Object.entries(want)
      .filter(([k, max]) => !(got[k] <= max))
      .map(([k, max]) => `${k}: expected <= ${max}, got ${got[k]}`),

  expect_min: (got, want) =>
    Object.entries(want)
      .filter(([k, min]) => !(got[k] >= min))
      .map(([k, min]) => `${k}: expected >= ${min}, got ${got[k]}`),

  // `redact` used to emit findings as an array of {type, value} objects. That
  // schema hung the decoder and was flattened into two parallel arrays, but this
  // checker was never updated - it read `got.findings`, which has not existed
  // since, so it could only ever fail. No golden case used it, which is exactly
  // why it survived. It now reads the shape the agent actually emits.
  expect_finding_types: (got, types) => {
    const found = new Set(got.finding_types ?? []);
    return types.filter((t) => !found.has(t)).map((t) => `missing finding type "${t}"`);
  },

  // Parallel arrays are index-aligned by convention only, so the suite asserts
  // on the convention. runtime.validate() reports the breakage; this turns it
  // into a failing case instead of a console note.
  expect_aligned: (got, groups, result) =>
    (result?.issues ?? [])
      .filter((i) => i.kind === "misaligned")
      .map((i) => `${i.fields.join(" / ")} out of step (${i.detail})`),
};

$("go").addEventListener("click", async () => {
  $("go").disabled = true;
  $("model").disabled = true;
  document.querySelector(".bar-track").hidden = false;
  $("rows").innerHTML = "";

  const modelId = $("model").value;
  const { cases } = await fetch("./goldens.json").then((r) => r.json());

  $("status").textContent = "Loading model…";
  await getEngine(modelId, (p, t) => {
    $("bar").style.width = `${Math.round(p * 100)}%`;
    $("status").textContent = t || "Loading…";
  });

  $("scoreboard").hidden = false;
  let passed = 0;
  let refusalPassed = 0;
  let refusalTotal = 0;
  let repairs = 0;
  let misaligned = 0;
  const times = [];

  for (const [i, c] of cases.entries()) {
    $("status").textContent = `Case ${i + 1} of ${cases.length}: ${c.name}`;
    $("bar").style.width = `${Math.round(((i + 1) / cases.length) * 100)}%`;

    const agent = byId(c.agent);
    const row = document.createElement("tr");
    let failures = [];

    try {
      const result = await runAgent(agent, c.input, { modelId });
      times.push(result.elapsedMs);
      repairs += result.repairs.length;

      for (const [key, checker] of Object.entries(CHECKS)) {
        if (c[key]) failures.push(...checker(result.data, c[key], result));
      }

      // Every case is implicitly an alignment case. A run that returns three
      // finding types and one finding value passed its assertions and still
      // produced an object no consumer can read.
      misaligned += result.issues.filter((i) => i.kind === "misaligned").length;
    } catch (err) {
      failures = [`threw: ${err.message}`];
    }

    const ok = failures.length === 0;
    if (ok) passed++;
    if (c.refusal) {
      refusalTotal++;
      if (ok) refusalPassed++;
    }

    row.innerHTML = `
      <td>${i + 1}</td>
      <td>${agent.name}</td>
      <td>${c.name} ${c.refusal ? '<span class="tag">refusal</span>' : ""}</td>
      <td class="${ok ? "pass" : "fail"}">${ok ? "PASS" : "FAIL"}</td>
      <td class="muted">${ok ? (c.note ?? "") : failures.join("<br>")}</td>
    `;
    $("rows").append(row);

    $("s-pass").textContent = passed;
    $("s-total").textContent = cases.length;
    $("s-refusal").textContent = `${refusalPassed}/${refusalTotal}`;
    $("s-repairs").textContent = repairs;
    $("s-misaligned").textContent = misaligned;
    $("s-time").textContent = times.length ? `${(median(times) / 1000).toFixed(1)}s` : "—";
  }

  $("status").textContent =
    `Done — ${passed}/${cases.length} passed, refusals ${refusalPassed}/${refusalTotal}, ` +
    `${misaligned} misaligned output${misaligned === 1 ? "" : "s"}.`;
  $("go").disabled = false;
  $("model").disabled = false;
});

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
