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
import cooldown from "./apps/cooldown.js";
import scam from "./apps/scam.js";
import pile from "./apps/pile.js";
import recommend from "./apps/recommend.js";
import workbench from "./apps/workbench.js";

const APPS = [braindump, cooldown, scam, pile, journal, recommend, workbench];
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
      if (button) {
        button.disabled = false;
        button.textContent = original;
      }
      activeController = null;
    }
  },

  /**
   * The agent trail.
   *
   * These apps plan, act, observe and revise, and hiding that behind a spinner
   * would throw away the most interesting thing about them - so every step the
   * loop takes renders as it happens.
   */
  trail() {
    const list = el("div.trail");
    const node = el("section.panel", { hidden: true },
      el("label.label", { text: "What the agent is doing" }), list);
    let n = 0;
    let pending = null;

    const settle = (cls, text) => {
      if (!pending) return;
      pending.mark.className = `trail-mark ${cls}`;
      pending.mark.textContent = cls === "bad" ? "!" : "✓";
      if (text) pending.step.append(el("div.trail-obs", { text }));
      pending = null;
    };

    const push = (tool, why) => {
      settle("done");
      node.hidden = false;
      const mark = el("div.trail-mark.working", { text: String(++n) });
      const step = el("div.trail-step", {}, mark,
        el("div", {}, el("div.trail-tool", { text: tool }), why && el("div.trail-why", { text: why })));
      list.append(step);
      pending = { mark, step };
      return step;
    };

    return {
      node,
      reset() { n = 0; pending = null; clear(list); node.hidden = true; },
      plan: push,
      done(tool, summary) { if (!pending) push(tool); settle("done", summary); },
      warn(tool, message) { if (!pending) push(tool); settle("bad", message); },

      /** Adapter for orchestrator.runLoop's onStep. */
      fromStep(step) {
        if (step.kind === "plan") push(step.tool, step.reason);
        else if (step.kind === "repeat") {
          push(step.tool, "already tried this exact call — skipped");
          settle("bad");
        } else if (step.kind === "observation") settle("done", step.summary);
        else if (step.kind === "error") settle("bad", step.message);
        else if (step.kind === "finish") {
          settle("done");
          node.hidden = false;
          list.append(el("div.trail-step", {},
            el("div.trail-mark.done", { text: "✓" }),
            el("div", {}, el("div.trail-tool", { text: "finished" }),
              el("div.trail-why", { text: step.reason }))));
        }
      },
    };
  },
};

/* ------------------------------------------------------------------ *
 * routing
 * ------------------------------------------------------------------ */

function home() {
  fill(view,
    el("section.hero", {},
      el("h1", { text: "Six apps. Nothing leaves your laptop." }),
      el("p.lede", {
        text: "Every one runs on your own GPU, in this tab. No account, no API key, no bill, " +
              "and they keep working with the wifi off." })),
    el("div.launcher", {}, APPS.map(card)),
    el("section.panel", {},
      el("h3", { text: "Why the browser" }),
      el("p.muted", { style: { marginTop: "10px" },
        text: "Inference costs nothing here, so these apps can do things a metered one cannot: " +
              "rewrite a message three times and grade itself each round, read back over every " +
              "journal entry you have written, search a whole shelf on every question. The bill " +
              "for all of it is the same — your battery." }))
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
