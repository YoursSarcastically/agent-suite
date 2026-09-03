/**
 * Braindump - messy paragraph in, real tasks out.
 *
 * The agentic part is not the extraction, which is one call. It is the second
 * half: an agent that reads the whole list - the new tasks and everything still
 * open from last week - and commits to one thing to do next, with a reason it
 * has to name from a closed set. Picking is a harder job than listing, and it
 * is the job people actually want done.
 */

import { el, fill, meter, titleCase } from "../dom.js";
import { BRAINDUMP, NEXT_ACTION } from "../app-agents.js";
import { collection } from "../store.js";

const tasks = collection("braindump:tasks", { cap: 300 });

const SAMPLE =
  "gotta call mum this week, ship the deck by fri, ben still owes me that invoice from march, " +
  "book dentist sometime, and I really need to cancel the gym before they bill me again";

export default {
  id: "braindump",
  name: "Braindump",
  icon: "braindump",
  blurb: "Type the way your head actually works. Get a real list back.",
  tag: "Extraction · one agent, one decision agent",

  mount(root, ctx) {
    const input = el("textarea.field", {
      placeholder: "Everything that's rattling around. Punctuation optional.",
      spellcheck: false,
      rows: 5,
    });
    const listEl = el("div.stack");
    const nextEl = el("div");
    const trail = ctx.trail();

    const sortBtn = el("button.btn.btn-primary", { onclick: sort }, "Sort this out");
    const nextBtn = el("button.btn", { onclick: whatNow }, "What now?");
    const sampleBtn = el(
      "button.btn.btn-ghost.btn-sm",
      { onclick: () => (input.value = SAMPLE) },
      "Use an example"
    );

    render();

    root.append(
      el(
        "section.panel",
        {},
        el("label.label", { text: "Brain dump" }),
        input,
        el("div.row", { style: { marginTop: "14px" } }, sortBtn, nextBtn, sampleBtn)
      ),
      trail.node,
      nextEl,
      el("section.panel", {}, el("label.label", { text: "Your list" }), listEl)
    );

    /* ---------------- extraction ---------------- */

    async function sort() {
      const text = input.value.trim();
      if (!text) return ctx.toast("Put something in the box first.");

      await ctx.busy(sortBtn, async (signal) => {
        trail.reset();
        trail.plan("braindump", "Pulling out every distinct thing you have to do");

        const result = await ctx.run(BRAINDUMP, text, { signal });
        const rows = zip(result.data);

        trail.done("braindump", `${rows.length} task${rows.length === 1 ? "" : "s"} found`);

        // The alignment check earns its keep here rather than in a test: parallel
        // arrays of different lengths would silently drop or duplicate a task.
        // Worth surfacing rather than hiding: this fires often, and it is the
        // clearest evidence of what flat schemas cost.
        if (result.issues.length) {
          trail.warn("validate", `${result.issues[0].detail} — padded to ${rows.length} rows`);
        }

        for (const row of rows) tasks.add({ ...row, done: false });
        input.value = "";
        render();
      });
    }

    /* ---------------- the decision ---------------- */

    async function whatNow() {
      const open = tasks.all().filter((t) => !t.done);
      if (!open.length) return ctx.toast("Nothing open. Enjoy it.");

      await ctx.busy(nextBtn, async (signal) => {
        trail.reset();
        trail.plan("next-action", "Reading the whole list and committing to one");

        const listing = open
          .map(
            (t, i) =>
              `${i + 1}. ${t.task} — ${t.project}, due ${t.due} (${t.priority}, about ${t.minutes} min)`
          )
          .join("\n");

        const { data } = await ctx.run(NEXT_ACTION, `MY LIST:\n${listing}`, { signal });
        const chosen = open[Math.min(Math.max(data.pick, 1), open.length) - 1];

        trail.done("next-action", titleCase(data.because));
        showNext(data, chosen);
        render(chosen?.id);
      });
    }

    function showNext(data, chosen) {
      fill(
        nextEl,
        el(
          "section.panel",
          {},
          el("div.row", {}, el("span.pill.pill-accent", { text: "Do this next" }),
             el("span.pill", { text: titleCase(data.because) })),
          el("h2", { text: chosen?.task ?? "", style: { margin: "12px 0 8px" } }),
          el("p.muted", { text: data.say_it }),
          data.skip_for_now && el("p.small.dim", { text: `Let go of: ${data.skip_for_now}` })
        )
      );
    }

    /* ---------------- list ---------------- */

    function render(highlight) {
      const all = tasks.all();
      if (!all.length) {
        return fill(
          listEl,
          el("div.empty", {}, el("div.big", { text: "\u{1F4AD}" }), el("p", { text: "Nothing here yet." }))
        );
      }

      const open = all.filter((t) => !t.done);
      const done = all.filter((t) => t.done);

      fill(
        listEl,
        el("div.row", { style: { marginBottom: "12px" } },
          el("span.pill", { text: `${open.length} open` }),
          done.length > 0 && el("span.pill", { text: `${done.length} done` }),
          done.length > 0 &&
            el("button.btn.btn-ghost.btn-sm", {
              onclick: () => { for (const t of done) tasks.remove(t.id); render(); },
            }, "Clear done")
        ),
        [...open, ...done].map((t) => taskRow(t, highlight === t.id))
      );
    }

    function taskRow(t, isChosen) {
      return el(
        `div.task${t.done ? ".done" : ""}${isChosen ? ".chosen" : ""}`,
        {},
        el(`button.check${t.done ? ".on" : ""}`, {
          "aria-label": t.done ? "Mark not done" : "Mark done",
          onclick: () => { tasks.update(t.id, { done: !t.done }); render(); },
        }, "✓"),
        el("div", {},
          el("div.task-text", { text: t.task }),
          el("div.task-meta", {},
            el("span.pill", { text: t.project }),
            el("span.pill", { text: t.due }),
            t.owner && t.owner !== "me" && el("span.pill", { text: t.owner }),
            el("span.pill", { text: `${t.minutes} min` })
          )
        ),
        el("div", { style: { width: "58px" } }, meter(priorityWeight(t.priority), 3, toneFor(t.priority)))
      );
    }
  },
};

/**
 * Parallel arrays into records.
 *
 * Length is taken from `tasks` alone rather than the shortest array, because
 * runtime.realign() has already padded the columns to match it. Taking the
 * minimum here is what silently deleted four of five tasks the first time a
 * real model collapsed a repeated column.
 */
function zip(d) {
  const n = d.tasks.length;
  return Array.from({ length: n }, (_, i) => ({
    task: d.tasks[i],
    owner: d.owners[i] ?? "me",
    due: d.due_dates[i] ?? "someday",
    priority: d.priorities[i] ?? "someday",
    project: d.projects[i] ?? "general",
    minutes: d.minutes[i] ?? 15,
  }));
}

const priorityWeight = (p) => ({ now: 3, soon: 2, someday: 1 }[p] ?? 1);
const toneFor = (p) => ({ now: "bad", soon: "warn", someday: "" }[p] ?? "");
