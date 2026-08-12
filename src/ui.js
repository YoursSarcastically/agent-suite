import { AGENTS, byId } from "./agents.js";
import { MODELS, DEFAULT_MODEL, checkSupport, getEngine, runAgent, unload } from "./runtime.js";

const $ = (id) => document.getElementById(id);
let current = null;
let loaded = false;
let running = false;

/* ---------- boot ---------- */

const support = checkSupport();
if (!support.ok) {
  const el = $("unsupported");
  el.textContent = support.reason;
  el.hidden = false;
  $("load").disabled = true;
}

MODELS.forEach((m) => {
  const opt = document.createElement("option");
  opt.value = m.id;
  opt.textContent = `${m.label} (${m.vram})`;
  if (m.id === DEFAULT_MODEL) opt.selected = true;
  $("model").append(opt);
});

$("load").addEventListener("click", async () => {
  const modelId = $("model").value;
  const btn = $("load");
  btn.disabled = true;
  $("model").disabled = true;
  document.querySelector(".bar-track").hidden = false;

  try {
    if (loaded) await unload();
    await getEngine(modelId, (progress, text) => {
      $("bar").style.width = `${Math.round(progress * 100)}%`;
      $("status").textContent = text || "Loading…";
    });
    loaded = true;
    $("status").textContent = `Ready — ${modelId}. Pick an agent below.`;
    $("bar").style.width = "100%";
    btn.textContent = "Reload model";
  } catch (err) {
    $("status").textContent = `Failed to load: ${err.message}`;
  } finally {
    btn.disabled = false;
    $("model").disabled = false;
  }
});

/* ---------- agent grid ---------- */

const grid = $("grid");
AGENTS.forEach((agent) => {
  const card = document.createElement("button");
  card.className = "card";
  card.type = "button";
  card.innerHTML = `
    <span class="icon" aria-hidden="true">${agent.icon}</span>
    <span class="card-name">${agent.name}</span>
    <span class="card-blurb">${agent.blurb}</span>
    <span class="card-fields">${Object.keys(agent.schema.properties).length} fields</span>
  `;
  card.addEventListener("click", () => open(agent.id));
  grid.append(card);
});

/* ---------- workbench ---------- */

function open(id) {
  current = byId(id);
  $("wb-title").textContent = `${current.icon}  ${current.name}`;
  $("wb-blurb").textContent = current.blurb;
  $("input").value = current.sample;
  $("output").textContent = "—";
  $("metrics").textContent = "";
  $("schema-note").textContent =
    `Decoding is constrained to: ${Object.keys(current.schema.properties).join(", ")}`;
  $("workbench").hidden = false;
  $("workbench").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("wb-close").addEventListener("click", () => {
  $("workbench").hidden = true;
  current = null;
});

$("reset").addEventListener("click", () => {
  if (current) $("input").value = current.sample;
});

$("run").addEventListener("click", async () => {
  if (!current || running) return;

  if (!loaded) {
    $("output").textContent = "Load a model first (button at the top).";
    return;
  }

  const input = $("input").value.trim();
  if (!input) {
    $("output").textContent = "Give the agent something to work with.";
    return;
  }

  running = true;
  $("run").disabled = true;
  $("run").textContent = "Running…";
  $("output").textContent = "";
  $("metrics").textContent = "";

  try {
    const result = await runAgent(current, input, {
      modelId: $("model").value,
      onToken: (t) => {
        $("output").textContent += t;
      },
    });
    // Re-render the streamed text as formatted JSON now that it is complete.
    $("output").textContent = JSON.stringify(result.data, null, 2);
    const repaired = result.repairs.length
      ? ` · ⚠ ${result.repairs.length} value${result.repairs.length > 1 ? "s" : ""} clamped to range`
      : "";
    $("metrics").textContent =
      `${(result.elapsedMs / 1000).toFixed(1)}s · ~${result.tokensPerSecond} tok/s · on-device${repaired}`;
  } catch (err) {
    $("output").textContent = `Error: ${err.message}`;
  } finally {
    running = false;
    $("run").disabled = false;
    $("run").textContent = "Run agent";
  }
});
