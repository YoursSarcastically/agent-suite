/** Page wrapper for the app eval suite. The measuring lives in apps.js. */
import { MODELS, DEFAULT_MODEL, getEngine } from "../src/runtime.js";
import { runAppEvals, SUITES } from "./apps.js";

const $ = (id) => document.getElementById(id);
const TOTAL = SUITES.reduce((n, s) => n + s.steps.length, 0);

for (const m of MODELS) {
  const o = document.createElement("option");
  o.value = m.id;
  o.textContent = `${m.label} · ${m.vram}`;
  o.selected = m.id === DEFAULT_MODEL;
  $("model").append(o);
}

$("go").addEventListener("click", async () => {
  $("go").disabled = $("model").disabled = true;
  $("rows").innerHTML = "";
  $("bar-track").hidden = false;

  const modelId = $("model").value;
  $("status").textContent = "Loading the model…";
  await getEngine(modelId, (p, t) => {
    $("bar").style.width = `${Math.round((p ?? 0) * 100)}%`;
    $("status").textContent = t || "Loading…";
  });

  let done = 0;
  const { summary } = await runAppEvals({
    modelId,
    onStep: (r) => {
      done++;
      $("bar").style.width = `${Math.round((done / TOTAL) * 100)}%`;
      $("status").textContent = `${r.app} · ${r.agent} · ${(r.ms / 1000).toFixed(1)}s`;
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${r.app}</td><td class="mono">${r.agent}</td>` +
        `<td class="num">${(r.ms / 1000).toFixed(1)}s</td>` +
        `<td class="num">${r.tps || "—"}</td><td class="num">${r.tokens || "—"}</td>` +
        `<td class="${r.pass ? "pass" : "fail"}">${r.pass ? "PASS" : r.failures.join("; ")}</td>`;
      $("rows").append(tr);
    },
  });

  $("summary").hidden = false;
  $("summary").innerHTML = [
    [`${summary.passed}/${summary.total}`, "checks passed"],
    [`${(summary.totalMs / 1000).toFixed(0)}s`, "all apps, end to end"],
    [`${summary.medianTps}`, "median tokens/sec"],
    ...summary.apps.map((a) => [`${(a.ms / 1000).toFixed(1)}s`, a.app.toLowerCase()]),
  ].map(([n, k]) => `<div class="proof-item"><span class="n">${n}</span><span class="k">${k}</span></div>`).join("");

  $("status").textContent = `Done — ${summary.passed}/${summary.total} passed.`;
  $("go").disabled = $("model").disabled = false;
});
