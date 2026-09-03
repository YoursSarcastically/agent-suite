/**
 * Cooldown - read a message before it ruins your week.
 *
 * This is the app that most needed a real loop rather than a single call, and
 * the reason is a genuine tension: a rewrite can fail in two opposite
 * directions. It can leave the damage in, or it can sand the message down until
 * the complaint has vanished and the writer sends something polite and pointless.
 * One pass cannot tell which happened.
 *
 * So it produces, grades itself against both failures, and revises with the
 * critique fed back in - up to three rounds, keeping the best. That triples the
 * number of generations per click, which is exactly why almost no cloud product
 * does it and exactly why it is free here.
 */

import { el, fill, meter, titleCase } from "../dom.js";
import { LANDING, SOFTEN, SOFTEN_CRITIC, SUBTEXT } from "../app-agents.js";
import { refine } from "../orchestrator.js";

const SAMPLES = {
  send:
    "Honestly I don't know why I'm the only person on this team who reads anything before a " +
    "meeting. We spent 40 minutes today on a document that took me 10 minutes to read last night. " +
    "If nobody else is going to prepare then I'd rather we cancelled it.",
  received: "ok. noted.",
};

export default {
  id: "cooldown",
  name: "Cooldown",
  icon: "cooldown",
  blurb: "Before you hit send at 1am. Or after they sent you two words and you've read them nine times.",
  tag: "Produce → critique → revise, up to 3 rounds",

  mount(root, ctx) {
    let mode = "send";

    const input = el("textarea.field", { rows: 6, placeholder: placeholderFor(mode) });
    const out = el("div");
    const trail = ctx.trail();

    const goBtn = el("button.btn.btn-primary", { onclick: go }, "Check it");
    const sampleBtn = el("button.btn.btn-ghost.btn-sm", {
      onclick: () => (input.value = SAMPLES[mode]),
    }, "Use an example");

    const tabs = el("div.row", { style: { marginBottom: "16px" } },
      tab("send", "I'm about to send this"),
      tab("received", "Someone sent me this"));

    root.append(
      el("section.panel", {}, tabs, input,
        el("div.row", { style: { marginTop: "14px" } }, goBtn, sampleBtn)),
      trail.node,
      out
    );

    function tab(id, label) {
      const b = el(`button.btn${mode === id ? ".btn-primary" : ".btn-ghost"}.btn-sm`, {
        onclick: () => {
          mode = id;
          input.placeholder = placeholderFor(id);
          fill(out);
          trail.reset();
          [...tabs.children].forEach((c) =>
            (c.className = `btn ${c.dataset.id === mode ? "btn-primary" : "btn-ghost"} btn-sm`));
        },
      }, label);
      b.dataset.id = id;
      return b;
    }

    async function go() {
      const text = input.value.trim();
      if (!text) return ctx.toast("Paste the message first.");
      await ctx.busy(goBtn, (signal) =>
        mode === "send" ? checkOutgoing(text, signal) : checkIncoming(text, signal));
    }

    /* ---------------- outgoing ---------------- */

    async function checkOutgoing(text, signal) {
      trail.reset();
      fill(out);

      trail.plan("landing", "Working out how this lands on the person reading it");
      const { data: landing } = await ctx.run(LANDING, text, { signal });
      trail.done("landing", `Reads as ${landing.reads_as} · damage ${Math.round(landing.damage)}/5`);

      renderLanding(landing);

      // A message that is genuinely fine should not be rewritten. Rewriting
      // everything is how a tone tool ends up flattening people who were
      // already being reasonable.
      const clearlyFine = ["fine", "blunt"].includes(landing.reads_as);
      if (landing.send_as_is && landing.damage <= 1 && clearlyFine) {
        trail.done("decide", "No rewrite needed — sending it as written is fine");
        out.append(el("section.panel", {},
          el("span.pill.pill-good", { text: "Send it" }),
          el("p.muted", { style: { marginTop: "10px" },
            text: "Nothing here needs softening. Not every direct message is a problem." })));
        return;
      }

      trail.plan("soften", "Rewriting, then grading the rewrite against the original");

      const rounds = [];
      const result = await refine({
        producer: SOFTEN,
        critic: SOFTEN_CRITIC,
        input: text,
        // The score is deliberately the *minimum* of the three, not the mean.
        // A rewrite that scores 5 on politeness and 0 on keeping the point is a
        // failure, and averaging would hide that behind a respectable number.
        scoreOf: (c) => Math.min(c.point_survives, c.damage_removed, c.sounds_like_them),
        threshold: 3,
        maxRounds: 3,
        modelId: ctx.modelId(),
        signal,
        onRound: ({ round, score, critique }) => {
          rounds.push({ round, score, critique });
          trail.done(`round ${round}`, `scored ${score}/5 — ${critique.critique}`);
        },
      });

      trail.done("soften", result.settled
        ? `Settled after ${result.rounds} round${result.rounds > 1 ? "s" : ""}`
        : `Best of ${result.rounds} rounds — never fully cleared the bar`);

      renderRewrite(result, rounds);
    }

    function renderLanding(d) {
      const tone = d.damage >= 4 ? "bad" : d.damage >= 2 ? "warn" : "good";
      out.append(el("section.panel", {},
        el("div.row", {},
          el("span", { class: `pill pill-${tone}`, text: titleCase(d.reads_as) }),
          el("span.spacer"),
          el("span.small.dim", { text: "damage" }),
          el("div", { style: { width: "84px" } }, meter(d.damage, 5, tone))),
        el("h2", { style: { margin: "16px 0 6px" }, text: d.they_will_hear }),
        el("p.muted", { text: `What you probably meant: ${d.you_probably_meant}` }),
        d.lines_that_hurt.length > 0 && el("div", {},
          el("label.label", { style: { marginTop: "16px" }, text: "The lines doing the damage" }),
          el("div.stack", {}, d.lines_that_hurt.map((l) =>
            el("div.card.small", { style: { borderLeft: "2px solid var(--bad)" }, text: `“${l}”` }))))
      ));
    }

    function renderRewrite(result, rounds) {
      const body = result.output?.rewritten ?? "";
      out.append(el("section.panel", {},
        el("div.row", {},
          el("span.pill.pill-accent", { text: "Send this instead" }),
          result.output && !result.output.still_says_it &&
            el("span.pill.pill-warn", { text: "⚠ the hard point may have been lost" }),
          el("span.spacer"),
          el("button.btn.btn-sm", {
            onclick: () => { navigator.clipboard?.writeText(body); ctx.toast("Copied."); },
          }, "Copy")),
        el("p", { style: { margin: "16px 0", whiteSpace: "pre-wrap" }, text: body }),
        result.output?.removed?.length > 0 && el("details", {},
          el("summary.small.muted", { text: "What was cut", style: { cursor: "pointer" } }),
          el("ul", { style: { margin: "8px 0 0", paddingLeft: "20px" } },
            result.output.removed.map((r) => el("li.small.dim", { text: r })))),
        rounds.length > 1 && el("p.small.dim", { style: { marginTop: "14px" },
          text: `Rewritten ${rounds.length} times, graded each round. Best score ${result.score}/5.` })
      ));
    }

    /* ---------------- incoming ---------------- */

    async function checkIncoming(text, signal) {
      trail.reset();
      fill(out);
      trail.plan("subtext", "Reading what they probably meant");

      const { data } = await ctx.run(SUBTEXT, text, { signal });
      trail.done("subtext", `${titleCase(data.likely_mood)} · overthinking risk ${Math.round(data.overthinking)}/5`);

      const overthinking = data.overthinking >= 4;

      fill(out, el("section.panel", {},
        el("div.row", {},
          el("span.pill", { text: titleCase(data.likely_mood) }),
          el("span", { class: `pill ${isNo(data.is_it_a_no) ? "pill-warn" : "pill-good"}`,
            text: noLabel(data.is_it_a_no) }),
          el("span.spacer"),
          overthinking && el("span.pill.pill-good", { text: "You're probably overthinking this" })),
        el("h2", { style: { margin: "16px 0 10px" }, text: data.probable_meaning }),
        overthinking && el("p.muted", {
          text: "Short messages are usually short because someone was busy. There is likely nothing in this one." }),
        el("label.label", { style: { marginTop: "18px" }, text: "A reply that moves it forward" }),
        el("div.card", {},
          el("p", { style: { margin: 0 }, text: data.reply_with }),
          el("div.row.row-end", { style: { marginTop: "10px" } },
            el("button.btn.btn-sm", {
              onclick: () => { navigator.clipboard?.writeText(data.reply_with); ctx.toast("Copied."); },
            }, "Copy")))
      ));
    }
  },
};

const placeholderFor = (mode) =>
  mode === "send"
    ? "Paste the thing you were about to send. It does not leave this tab, which is the only reason you'd paste it anywhere."
    : "Paste what they sent you. Two words is enough.";

const isNo = (v) => v === "yes_softly" || v === "yes_clearly";
const noLabel = (v) => ({
  no_its_not: "Not a refusal",
  yes_softly: "That's a soft no",
  yes_clearly: "That's a no",
  cant_tell: "Genuinely unclear",
}[v] ?? v);
