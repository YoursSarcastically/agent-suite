/**
 * Journal - write freely, get filed automatically.
 *
 * Two agents with different jobs. The first reads one entry and records what is
 * in it, with no interpretation. The second reads across many entries and is
 * allowed to draw a conclusion - but it can also return found=false, and that
 * matters more here than anywhere else in the project. A fabricated insight
 * about a support ticket is an annoyance. A fabricated insight about someone's
 * own life is a small harm, so refusing is wired in as a first-class outcome.
 */

import { el, fill, ago, titleCase } from "../dom.js";
import { JOURNAL_READ, JOURNAL_PATTERN } from "../app-agents.js";
import { collection } from "../store.js";

const entries = collection("journal:entries", { cap: 400 });

const MOOD_TONE = {
  good: "good", excited: "good", content: "good",
  flat: "", tired: "", steady: "",
  anxious: "warn", frustrated: "warn",
  low: "bad",
};

export default {
  id: "journal",
  name: "Journal",
  icon: "journal",
  blurb: "Write freely. It tracks your mood, people and promises.",

  mount(root, ctx) {
    const input = el("textarea.field", {
      placeholder: "How was today? Write however you like.",
      rows: 7,
    });
    const historyEl = el("div.stack");
    const insightEl = el("div");
    const chartEl = el("div");
    const trail = ctx.trail();

    const saveBtn = el("button.btn.btn-primary", { onclick: save }, "Save entry");
    const patternBtn = el("button.btn", { onclick: findPattern }, "Find patterns");

    render();

    root.append(
      el("section.panel", {},
        el("label.label", { text: "Today's entry" }),
        input,
        el("div.row", { style: { marginTop: "14px" } }, saveBtn, patternBtn)
      ),
      trail.node,
      insightEl,
      chartEl,
      el("section.panel", {}, el("label.label", { text: "Past entries" }), historyEl)
    );

    /* ---------------- one entry ---------------- */

    async function save() {
      const text = input.value.trim();
      if (!text) return ctx.toast("Write something first.");

      await ctx.busy(saveBtn, async (signal) => {
        trail.reset();
        trail.plan("journal-read", "Reading your entry");

        const { data } = await ctx.run(JOURNAL_READ, text, { signal });
        entries.add({ text, ...data });

        trail.done("journal-read", `${data.mood} · ${data.people.length} people · ${data.topics.length} topics`);
        input.value = "";
        render();
        ctx.toast("Saved.");
      });
    }

    /* ---------------- across entries ---------------- */

    async function findPattern() {
      const all = entries.all();
      if (all.length < 3) return ctx.toast("Write at least three entries first.");

      await ctx.busy(patternBtn, async (signal) => {
        trail.reset();
        trail.plan("journal-pattern", `Looking across your last ${Math.min(all.length, 14)} entries`);

        const digest = all
          .slice(0, 14)
          .reverse()
          .map((e) => `${new Date(e.at).toLocaleDateString()} — ${e.mood} (${e.mood_score}/5): ${e.one_line}` +
            (e.worries.length ? ` [worried about: ${e.worries.join("; ")}]` : ""))
          .join("\n");

        const { data } = await ctx.run(JOURNAL_PATTERN, `ENTRIES:\n${digest}`, { signal });

        if (!data.found) {
          trail.warn("journal-pattern", "Declined — not enough signal to call it a pattern");
          fill(insightEl, el("section.panel", {},
            el("span.pill", { text: "No clear pattern" }),
            el("p.muted", { style: { marginTop: "10px" },
              text: "Your entries are too varied to draw a conclusion yet. Write a few more." })
          ));
          return;
        }

        trail.done("journal-pattern", titleCase(data.trend));
        fill(insightEl, el("section.panel", {},
          el("div.row", {},
            el("span.pill.pill-accent", { text: "Pattern" }),
            el("span.pill", { text: titleCase(data.trend) })),
          el("h2", { text: data.pattern, style: { margin: "12px 0 10px" } }),
          data.evidence.length > 0 &&
            el("div.stack", {}, data.evidence.map((q) => el("div.card.small.muted", { text: `“${q}”` }))),
          data.question && el("p", { style: { marginTop: "14px" }, class: "muted",
            text: `Something to think about: ${data.question}` })
        ));
      });
    }

    /* ---------------- history + chart ---------------- */

    function render() {
      const all = entries.all();

      if (!all.length) {
        fill(chartEl);
        return fill(historyEl,
          el("div.empty", {}, el("div.big", { text: "\u{1F58A}" }),
            el("p", { text: "No entries yet. The mood chart appears after a few." })));
      }

      renderChart(all);

      const people = countBy(all.flatMap((e) => e.people));
      const topics = countBy(all.flatMap((e) => e.topics));
      const commitments = all.flatMap((e) => e.commitments.map((c) => ({ c, at: e.at })));

      fill(historyEl,
        el("div.row", { style: { marginBottom: "14px" } },
          el("span.pill", { text: `${all.length} entries` }),
          people[0] && el("span.pill", { text: `Mentions most: ${people[0][0]}` }),
          topics[0] && el("span.pill", { text: `Writes most about: ${topics[0][0]}` })
        ),
        commitments.length > 0 &&
          el("details.card", { style: { marginBottom: "12px" } },
            el("summary", { text: `${commitments.length} things you said you would do`,
              style: { cursor: "pointer", fontWeight: "570" } }),
            el("ul", { style: { margin: "10px 0 0", paddingLeft: "20px" } },
              commitments.slice(0, 12).map((x) =>
                el("li.small.muted", { text: `${x.c} — ${ago(x.at)}` })))
          ),
        all.slice(0, 20).map((e) =>
          el("div.card", {},
            el("div.row", {},
              el("span.pill", { class: `pill-${MOOD_TONE[e.mood] || ""}`.replace("pill-", "pill-") ,
                text: titleCase(e.mood) }),
              el("span.pill", { text: `${e.mood_score}/5` }),
              el("span.dim.small", { text: ago(e.at) })),
            el("p", { style: { margin: "9px 0 0" }, text: e.one_line }),
            e.people.length > 0 && el("div.task-meta", {}, e.people.map((p) => el("span.pill", { text: p })))
          ))
      );
    }

    function renderChart(all) {
      const points = all.slice(0, 30).reverse();
      if (points.length < 2) return fill(chartEl);

      const avg = points.reduce((s, e) => s + e.mood_score, 0) / points.length;

      fill(chartEl,
        el("section.panel", {},
          el("div.row", { style: { marginBottom: "14px" } },
            el("label.label", { text: "Mood over time", style: { margin: 0 } }),
            el("span.spacer"),
            el("span.pill", { text: `average ${avg.toFixed(1)} / 5` })),
          el("div.spark", {}, points.map((e) =>
            el("i", {
              style: { height: `${Math.max(6, (e.mood_score / 5) * 100)}%` },
              title: `${new Date(e.at).toLocaleDateString()} — ${e.mood} (${e.mood_score}/5)`,
            })))
        ));
    }
  },
};

function countBy(values) {
  const map = new Map();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}
