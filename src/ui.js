/**
 * The shell.
 *
 * One page, hash routing, and - the part that matters - one engine shared by
 * every app. Loading weights costs a gigabyte on the first visit and several
 * seconds on every one after, so navigating between apps must never reload the
 * page. That single constraint is why this is a router rather than six files.
 */

import { el, fill, clear } from "./dom.js";
import { icon } from "./icons.js";
import {
  MODELS, DEFAULT_MODEL, checkSupport, describeDevice,
  getEngine, isLoaded, loadedModel, runAgent, interrupt, unload,
} from "./runtime.js";

import braindump from "./apps/braindump.js";
import journal from "./apps/journal.js";
import pile from "./apps/pile.js";
import recommend from "./apps/recommend.js";
import workbench from "./apps/workbench.js";

const APPS = [braindump, pile, journal, recommend, workbench];
const byId = (id) => APPS.find((a) => a.id === id);

const view = document.getElementById("view");
const toastEl = document.getElementById("toast");

/* ------------------------------------------------------------------ *
 * engine boot
 * ------------------------------------------------------------------ */

const modelSelect = el("select.field",
  {}, MODELS.map((m) => el("option", { value: m.id, selected: m.id === DEFAULT_MODEL },
    `${m.label} · ${m.vram}`)));

const statusEl = el("span.small.dim", { text: "No model loaded" });
const barTrack = document.getElementById("bar-track");
const bar = document.getElementById("bar");

const loadBtn = el("button.btn.btn-primary.btn-sm", { onclick: load }, "Load model");
const devicePill = el("span.pill", { hidden: true });

describeDevice().then((d) => {
  devicePill.textContent = d.label;
  devicePill.hidden = false;
});

const support = checkSupport();
if (!support.ok) {
  loadBtn.disabled = true;
  statusEl.textContent = support.reason;
}

async function load() {
  const modelId = modelSelect.value;
  loadBtn.disabled = modelSelect.disabled = true;
  barTrack.hidden = false;

  try {
    if (isLoaded() && loadedModel() !== modelId) await unload();
    await getEngine(modelId, (progress, text) => {
      bar.style.width = `${Math.round(progress * 100)}%`;
      statusEl.textContent = text || "Loading…";
    });
    bar.style.width = "100%";
    statusEl.textContent = `Ready · ${MODELS.find((m) => m.id === modelId)?.label ?? modelId}`;
    loadBtn.textContent = "Reload";
    setTimeout(() => (barTrack.hidden = true), 700);
  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
  } finally {
    loadBtn.disabled = modelSelect.disabled = false;
  }
}

/** Apps call this before running anything; first use triggers the download. */
async function ensureModel() {
  if (isLoaded()) return;
  toast("Loading the model — first time is a big download, then it's cached.");
  await load();
  if (!isLoaded()) throw new Error("The model is not loaded.");
}

document.getElementById("boot").append(
  el("span.dot-live"), statusEl, devicePill, modelSelect, loadBtn
);

/* ------------------------------------------------------------------ *
 * shared context handed to every app
 * ------------------------------------------------------------------ */

let activeController = null;
/** Live status lines, so a finished run always clears its own. */
const trails = new Set();

const ctx = {
  modelId: () => modelSelect.value,
  toast,

  /** Run one agent. Loads the model on first use rather than scolding the user. */
  async run(agent, input, opts = {}) {
    await ensureModel();
    return runAgent(agent, input, { modelId: modelSelect.value, ...opts });
  },

  /**
   * Wrap a long action: disable the button, offer a stop, surface failures as
   * a toast rather than a silent dead end. Every app routes through this so
   * that cancelling actually reaches the engine.
   */
  async busy(button, fn) {
    if (activeController) return toast("Something is already running.");
    activeController = new AbortController();

    const original = button?.textContent;
    const stopBtn = el("button.btn.btn-sm", { onclick: () => { activeController?.abort(); interrupt(); } }, "Stop");
    if (button) {
      button.disabled = true;
      button.textContent = "Working…";
      button.after(stopBtn);
    }

    try {
      await fn(activeController.signal);
    } catch (err) {
      if (err.name !== "AbortError") {
        toast(err.message);
        console.error(err);
      }
    } finally {
      stopBtn.remove();
      for (const line of trails) { line.hidden = true; line.textContent = ""; }
      if (button) {
        button.disabled = false;
        button.textContent = original;
      }
      activeController = null;
    }
  },

  /**
   * Progress.
   *
   * This was a stepped panel listing every decision the loop made - which was
   * the most interesting thing on screen for about a week and clutter forever
   * after. What a person waiting thirty seconds needs is one line saying what
   * is happening now, so that is all this is. The full step sequence is still
   * available where it belongs, in the console via the loop's onStep.
   *
   * The API is unchanged so apps did not have to be rewritten around it.
   */
  trail() {
    const node = el("p.working", { hidden: true });
    const say = (text) => {
      if (!text) return;
      node.textContent = text;
      node.hidden = false;
    };

    const api = {
      node,
      reset() { node.hidden = true; node.textContent = ""; },
      plan: (tool, why) => say(why || tool),
      done: (tool, summary) => say(summary || tool),
      warn: (tool, message) => say(message || tool),
      fromStep(step) {
        if (step.kind === "plan") say(step.reason || step.tool);
        else if (step.kind === "observation") say(step.summary);
        else if (step.kind === "error") say(step.message);
        else if (step.kind === "finish") api.reset();
      },
    };

    trails.add(node);
    return api;
  },
};

/* ------------------------------------------------------------------ *
 * routing
 * ------------------------------------------------------------------ */

function home() {
  fill(view,
    el("section.hero", {},
      el("h1", { text: "Four apps. Nothing leaves your laptop." }),
      el("p.lede", {
        text: "Every one runs on your own GPU, in this tab. No account, no API key, no bill, " +
              "and they keep working with the wifi off." })),
    el("div.launcher", {}, APPS.map(card)),
    el("section.panel", {},
      el("h3", { text: "Why the browser" }),
      el("p.muted", { style: { marginTop: "10px" },
        text: "Inference costs nothing here, so these apps can do things a metered one cannot: " +
              "read back over every journal entry you have written, search a whole shelf on every " +
              "question, throw away a set of search results and try different words. The bill for " +
              "all of it is the same — your battery." }))
  );
}

function card(app) {
  return el("button.app-card", {
    type: "button",
    onclick: () => (location.hash = app.id),
  },
    el("div.app-icon", {}, icon(app.icon)),
    el("h3", { text: app.name }),
    el("p.blurb", { text: app.blurb }));
}

function openApp(app) {
  const body = el("div.stack");
  fill(view, el("div.view", {},
    el("div.view-head", {},
      el("button.btn.btn-ghost.btn-icon", { onclick: () => (location.hash = ""), "aria-label": "Back" }, "←"),
      el("div.app-icon", {}, icon(app.icon)),
      el("div", {},
        el("h1", { text: app.name }),
        el("p.sub", { text: app.blurb }),
        app.tag && el("p.sub.dim.small", { style: { marginTop: "6px" }, text: app.tag }))),
    body));

  app.mount(body, ctx);
}

function route() {
  const id = location.hash.replace(/^#/, "");
  const app = byId(id);
  activeController?.abort();
  window.scrollTo({ top: 0 });
  app ? openApp(app) : home();
}

addEventListener("hashchange", route);
route();

/* ------------------------------------------------------------------ *
 * toast
 * ------------------------------------------------------------------ */

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4200);
}
