/**
 * The shell.
 *
 * One page, hash routing, and - the part that matters - one engine shared by
 * every app. Loading weights costs well over a gigabyte on the first visit and
 * a long GPU upload on every one after, so navigating between apps must never
 * reload the page. That single constraint is why this is a router rather than
 * four separate files.
 *
 * The other structural decision is the gate. Nothing here works without a
 * model, and a browser cannot borrow one - so rather than letting someone type
 * into a box that will reject them, the apps do not exist until the engine is
 * ready. It is the one piece of onboarding an in-browser LLM genuinely needs,
 * because the wait is real and unavoidable and pretending otherwise just moves
 * the confusion later.
 */

import { el, fill, clear } from "./dom.js";
import { icon } from "./icons.js";
import {
  MODELS, DEFAULT_MODEL, checkSupport, describeDevice,
  getEngine, isLoaded, loadedModel, runAgent, interrupt, unload,
  storageReport, clearModelCache,
} from "./runtime.js";
import { read, write } from "./store.js";

import braindump from "./apps/braindump.js";
import journal from "./apps/journal.js";
import pile from "./apps/pile.js";
import recommend from "./apps/recommend.js";
import workbench from "./apps/workbench.js";

/** Byline. Replace with the real profile URL. */
const AUTHOR = { name: "Suraj", linkedin: "https://www.linkedin.com/in/YOUR-PROFILE/" };

const APPS = [braindump, pile, journal, recommend, workbench];
const byId = (id) => APPS.find((a) => a.id === id);

const view = document.getElementById("view");
const toastEl = document.getElementById("toast");
const barTrack = document.getElementById("bar-track");
const bar = document.getElementById("bar");

/* ------------------------------------------------------------------ *
 * engine
 * ------------------------------------------------------------------ */

const device = { label: "" };
const support = checkSupport();

/** Whether this browser has downloaded these weights before, for honest wording. */
const seenBefore = () => read("engine:loaded", []).includes(DEFAULT_MODEL);

let loading = false;
let outOfSpace = false;
let progressText = "";
let progressPct = 0;

describeDevice().then((d) => {
  device.label = d.label;
  render();
});

async function load(modelId) {
  if (loading) return;
  loading = true;
  progressPct = 0;
  progressText = "Starting…";
  render();

  try {
    if (isLoaded() && loadedModel() !== modelId) await unload();
    await getEngine(modelId, (progress, text) => {
      progressPct = Math.round((progress ?? 0) * 100);
      progressText = text || "Loading…";
      paintProgress();
    });
    write("engine:loaded", [...new Set([...read("engine:loaded", []), modelId])]);
    toast(`Ready. ${labelFor(modelId)} is running on ${device.label || "your GPU"}.`);
  } catch (err) {
    // The cache-full failure arrives as an opaque internal error, so it is
    // named here rather than passed through.
    const room = await storageReport();
    progressText = /cache/i.test(err.message) || room.free < 200e6
      ? `Out of browser storage — ${(room.usage / 1024 ** 3).toFixed(1)} GB of ` +
        `${(room.quota / 1024 ** 3).toFixed(1)} GB is used by models already downloaded.`
      : `Could not load: ${err.message}`;
    outOfSpace = /storage/i.test(progressText);
  } finally {
    loading = false;
    render();
  }
}

/**
 * WebLLM's progress string is written for a console, not a person:
 *
 *   "Fetching param cache[31/58]: 998MB fetched. 57% completed, 85 secs
 *    elapsed. It can take a while when we first visit this page to populate
 *    the cache. Later refreshes will become faster."
 *
 * Four sentences, one of which is an apology. What someone waiting actually
 * needs is which of the two phases they are in, how far through, and roughly
 * how much longer - so the string is parsed down to that and the rest dropped.
 */
function readProgress(text) {
  const downloading = /fetch/i.test(text);
  const loading = /loading model|from cache/i.test(text);
  const mb = Number(text.match(/([\d.]+)\s*MB/i)?.[1] ?? 0);
  const secs = Number(text.match(/(\d+)\s*secs?\s*elapsed/i)?.[1] ?? 0);
  const pct = Number(text.match(/(\d+)%\s*completed/i)?.[1] ?? NaN);

  let phase = "Starting up";
  if (loading) phase = "Loading onto your GPU";
  else if (downloading) phase = "Downloading the model";
  else if (/finish/i.test(text)) phase = "Almost ready";

  // Remaining time from the rate so far. Only shown once there is enough of a
  // sample for it not to be a wild guess.
  let eta = "";
  if (secs > 6 && pct >= 5 && pct < 100) {
    const left = Math.round((secs / pct) * (100 - pct));
    if (left > 3) eta = left >= 60 ? `about ${Math.round(left / 60)} min left` : `about ${left}s left`;
  }

  return { phase, mb, pct: Number.isFinite(pct) ? pct : null, eta };
}

/** Progress updates many times a second; repainting the whole view would thrash. */
function paintProgress() {
  const p = readProgress(progressText);
  const set = (id, value) => {
    const node = document.getElementById(id);
    if (node && value != null) node.textContent = value;
  };

  set("progress-phase", p.phase);
  set("progress-pct", p.pct == null ? "" : `${p.pct}%`);
  set("progress-detail", [p.mb ? `${p.mb >= 1024 ? (p.mb / 1024).toFixed(1) + " GB" : p.mb + " MB"}` : "", p.eta]
    .filter(Boolean).join(" · "));

  if (barTrack) barTrack.hidden = true;
  const fill = document.getElementById("progress-fill");
  if (fill && p.pct != null) fill.style.width = `${p.pct}%`;
}

const labelFor = (id) => MODELS.find((m) => m.id === id)?.label ?? id;

/* ------------------------------------------------------------------ *
 * what this tab has actually done
 * ------------------------------------------------------------------ */

/**
 * The value proposition is not a sentence, it is a number: generations that
 * happened here, at this speed, for nothing. Claiming it is weak; counting it
 * is not, so the home screen shows a running total rather than an adjective.
 */
const stats = { runs: 0, tokens: 0, tps: 0 };

/* ------------------------------------------------------------------ *
 * shared context handed to every app
 * ------------------------------------------------------------------ */

let activeController = null;
const trails = new Set();

const ctx = {
  modelId: () => loadedModel() ?? DEFAULT_MODEL,
  toast,

  async run(agent, input, opts = {}) {
    const result = await runAgent(agent, input, { modelId: ctx.modelId(), ...opts });
    stats.runs++;
    stats.tokens += result.completionTokens ?? 0;
    stats.tps = result.tokensPerSecond ?? stats.tps;
    return result;
  },

  /**
   * Wrap a long action: disable the button, offer a stop, surface failures as a
   * toast rather than a silent dead end. Every app routes through this so that
   * cancelling actually reaches the engine.
   */
  async busy(button, fn) {
    if (activeController) return toast("Wait for the current task to finish.");
    activeController = new AbortController();

    const original = button?.textContent;
    const stopBtn = el("button.btn.btn-sm", {
      onclick: () => { activeController?.abort(); interrupt(); },
    }, "Stop");
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
   * This was a stepped panel listing every decision the loop made, which was
   * the most interesting thing on screen for about a week and clutter forever
   * after. What someone waiting thirty seconds needs is one line saying what is
   * happening now. The full sequence is still available through the loop's
   * onStep, in the console.
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
 * screens
 * ------------------------------------------------------------------ */

/** Nothing works without WebGPU, so say so once and stop. */
function unsupported() {
  return el("section.gate", {},
    el("h1", { text: "This needs WebGPU." }),
    el("p.lede", { text: support.reason }));
}

/**
 * Onboarding.
 *
 * One decision and one wait. The size is stated up front because it is large
 * and finding that out through a stalled progress bar is worse than being
 * told; the second visit says so too, because a cached load is a different
 * promise from a cold one.
 */
function gate() {
  const modelId = DEFAULT_MODEL;
  const model = MODELS.find((m) => m.id === modelId);
  const returning = seenBefore();

  const picker = el("select.field", { disabled: loading },
    MODELS.map((m) => el("option", { value: m.id, selected: m.id === modelId },
      `${m.label} · ${m.vram}`)));

  const go = el("button.btn.btn-primary.btn-lg", {
    disabled: loading,
    onclick: () => load(picker.value),
  }, loading ? "Loading…" : returning ? "Start" : `Download ${model.vram.replace("~", "")}`);

  return el("section.gate", {},
    el("h1", {}, "An AI that runs", el("br"), el("span.dim", { text: "on your computer." })),
    el("p.lede", {
      text: returning
        ? "The model is already downloaded. Starting it takes a few seconds."
        : "Four small apps, powered by an AI model that downloads once and then runs " +
          "entirely on your own computer. Nothing you type is ever sent anywhere. " +
          "No account, no subscription, and it works without internet.",
    }),

    loading
      ? el("div.progress", {},
          el("div.progress-head", {},
            el("span.progress-phase", { id: "progress-phase", text: "Starting up" }),
            el("span.spacer"),
            el("span.progress-pct.nums", { id: "progress-pct", text: "" })),
          el("div.progress-track", {}, el("div.progress-fill", { id: "progress-fill" })),
          el("div.row", {},
            el("span.small.dim", { id: "progress-detail", text: "" }),
            el("span.spacer"),
            el("span.small.dim", { text: "downloads once, then cached" })))
      : el("div.gate-actions", {}, go, picker),

    !loading && el("div.proof", {}, [
      [model.vram.replace("~", ""), "downloads once"],
      [device.label || "your GPU", "runs on"],
      ["0", "data sent"],
      ["Free", "always"],
    ].map(([n, k]) => el("div.proof-item", {},
      el("span.n", { text: n }), el("span.k", { text: k })))),

    byline(),

    !loading && progressText.startsWith("Could not load") &&
      el("p.small.dim", { style: { marginTop: "18px" }, text: progressText }),

    // WebLLM keeps every model it has ever downloaded. Switching a few times
    // fills the quota, and from there nothing loads until something is dropped.
    !loading && outOfSpace && el("div", { style: { marginTop: "18px" } },
      el("p.small.dim", { text: progressText }),
      el("button.btn.btn-sm", {
        style: { marginTop: "12px" },
        onclick: async () => {
          const n = await clearModelCache();
          outOfSpace = false;
          progressText = "";
          toast(n ? "Deleted. Try loading again." : "Nothing to delete.");
          render();
        },
      }, "Delete old models"))
  );
}

/**
 * Shown on the gate and on the home screen.
 *
 * Renders as plain text while the URL is still the placeholder - a live site
 * with a dead byline link is worse than a byline without one.
 */
function byline() {
  const linked = AUTHOR.linkedin && !AUTHOR.linkedin.includes("YOUR-PROFILE");
  return el("p.byline", {},
    "Built by ",
    linked
      ? el("a", { href: AUTHOR.linkedin, target: "_blank", rel: "noopener noreferrer" },
          AUTHOR.name, el("span.byline-arrow", { text: "↗" }))
      : AUTHOR.name);
}

function home() {
  const apps = APPS.filter((a) => a.id !== "workbench");
  const bench = byId("workbench");

  fill(view,
    el("section.hero-home", {},
      el("h1", { text: "Four apps." }),
      el("div.proof", {}, [
        [labelFor(loadedModel()), "running on " + (device.label || "your GPU")],
        [stats.runs ? `${stats.tps}` : "—", "words per second"],
        [String(stats.runs), stats.runs === 1 ? "request, all local" : "requests, all local"],
        ["Free", "always"],
      ].map(([n, k]) => el("div.proof-item", {},
        el("span.n", { text: n }), el("span.k", { text: k }))))),

    el("div.launcher", {}, apps.map(card)),

    el("button.under", { onclick: () => (location.hash = "workbench") },
      icon(bench.icon), "Under the hood", el("span.dim", { text: "→" })),

    byline()
  );
}

function card(app) {
  return el("button.app-card", { type: "button", onclick: () => (location.hash = app.id) },
    el("div.app-icon", {}, icon(app.icon)),
    el("h3", { text: app.name }),
    el("p.blurb", { text: app.blurb }));
}

function openApp(app) {
  const body = el("div.stack");
  fill(view, el("div.view", {},
    el("div.view-head", {},
      el("button.btn.btn-ghost.btn-icon", {
        onclick: () => (location.hash = ""), "aria-label": "Back",
      }, "←"),
      el("div.app-icon", {}, icon(app.icon)),
      el("div", {}, el("h1", { text: app.name }), el("p.sub", { text: app.blurb }))),
    body));

  app.mount(body, ctx);
}

/* ------------------------------------------------------------------ *
 * routing
 * ------------------------------------------------------------------ */

function render() {
  if (barTrack) barTrack.hidden = !loading;

  if (!support.ok) return fill(view, unsupported());
  // The gate is not advisory. An app with no engine behind it is a form that
  // throws, so the route simply does not resolve until there is one.
  if (!isLoaded()) return fill(view, gate());

  const app = byId(location.hash.replace(/^#/, ""));
  app ? openApp(app) : home();
}

function route() {
  activeController?.abort();
  window.scrollTo({ top: 0 });
  render();
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
