/**
 * The Pile - the read-later list that reads itself.
 *
 * Saving was never the hard part. The hard part is that a pile of 400 articles
 * is a decision you have to make every time you look at it, so this app is
 * built around not making you decide: ask for something half-remembered and it
 * finds it, say how long you have and it picks one, and it will tell you what
 * your saving habits say about you whether you asked or not.
 *
 * Semantic search here is the model reading a shelf index, not embeddings. That
 * is slower and it does not scale past a few hundred items, but it needs no
 * second model download and it degrades honestly: the librarian is allowed to
 * return found=false rather than confidently handing over the wrong article.
 */

import { el, fill, ago } from "../dom.js";
import { SHELF_READ, LIBRARIAN, SHELF_PICK, MIRROR } from "../app-agents.js";
import { runLoop } from "../orchestrator.js";
import { collection } from "../store.js";

const shelf = collection("pile:articles", { cap: 250 });

export default {
  id: "pile",
  name: "The Pile",
  icon: "pile",
  blurb: "Everything you saved and never read. Now it answers questions.",
  tag: "Agent loop over your own shelf",

  mount(root, ctx) {
    const paste = el("textarea.field", {
      rows: 4,
      placeholder: "Paste an article — the whole thing. It gets read once and filed forever.",
    });
    const ask = el("input.field", {
      type: "text",
      placeholder: "\"the one about why teams get slower as they grow\"",
    });
    const answerEl = el("div");
    const shelfEl = el("div.stack");
    const trail = ctx.trail();

    const saveBtn = el("button.btn.btn-primary", { onclick: save }, "File it");
    const askBtn = el("button.btn.btn-primary", { onclick: askShelf }, "Ask the shelf");
    const timeBtn = el("button.btn", { onclick: () => askShelf("I have 10 minutes and low energy") },
      "I have 10 minutes");
    const mirrorBtn = el("button.btn", { onclick: () => askShelf("what do my saving habits say about me") },
      "Tell me something uncomfortable");

    ask.addEventListener("keydown", (e) => { if (e.key === "Enter") askShelf(); });

    // Dropping a text file is the least friction the browser allows without an
    // extension; a bookmarklet would be the next step and needs no server either.
    root.addEventListener("dragover", (e) => e.preventDefault());
    root.addEventListener("drop", async (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      paste.value = await file.text();
      ctx.toast(`Loaded ${file.name} — press "File it".`);
    });

    render();

    root.append(
      el("section.panel", {},
        el("label.label", { text: "Add to the pile" }),
        paste,
        el("div.row", { style: { marginTop: "14px" } }, saveBtn,
          el("span.small.dim", { text: "or drop a .txt / .md file anywhere on this page" }))),
      el("section.panel", {},
        el("label.label", { text: "Ask" }),
        ask,
        el("div.row", { style: { marginTop: "14px" } }, askBtn, timeBtn, mirrorBtn)),
      trail.node,
      answerEl,
      el("section.panel", {}, el("label.label", { text: "The shelf" }), shelfEl)
    );

    /* ---------------- filing ---------------- */

    async function save() {
      const text = paste.value.trim();
      if (text.length < 120) return ctx.toast("Paste a bit more — that is too short to file usefully.");

      await ctx.busy(saveBtn, async (signal) => {
        trail.reset();
        trail.plan("shelf-read", "Reading it once so it never has to be read again");

        // Long articles blow the context window; the opening is where the
        // argument lives, and the tail is usually related-links furniture.
        const { data } = await ctx.run(SHELF_READ, text.slice(0, 6000), { signal });
        shelf.add({ ...data, text: text.slice(0, 20000), read: false });

        trail.done("shelf-read", `${data.title} — ${data.minutes} min, ${data.difficulty}`);
        paste.value = "";
        render();
        ctx.toast("Filed.");
      });
    }

    /* ---------------- the loop ---------------- */

    async function askShelf(preset) {
      const query = preset ?? ask.value.trim();
      if (!query) return ctx.toast("Ask it something.");

      const all = shelf.all();
      if (!all.length) return ctx.toast("Nothing on the shelf yet.");

      await ctx.busy(preset ? undefined : askBtn, async (signal) => {
        trail.reset();
        fill(answerEl);

        const index = all
          .map((a, i) => `${i + 1}. ${a.title} — ${a.one_liner} [${a.topics.join(", ")}] ` +
            `(${a.minutes} min, ${a.difficulty}, ${a.read ? "read" : "unread"})`)
          .join("\n");

        const tools = [
          {
            name: "find_by_description",
            description: "Find the one article the person is half-remembering. Use when they describe an article.",
            run: async () => {
              const { data } = await ctx.run(LIBRARIAN,
                `SHELF:\n${index}\n\nTHEY REMEMBER:\n"${query}"`, { signal });
              return data.found ? { ...data, article: all[data.pick - 1] } : { found: false };
            },
            summarize: (r) => (r.found ? `matched: ${r.article?.title}` : "nothing on the shelf matches"),
          },
          {
            name: "pick_for_time",
            description: "Choose one article to read right now. Use when they mention how much time or energy they have.",
            run: async () => {
              const unread = all.filter((a) => !a.read);
              const pool = (unread.length ? unread : all)
                .map((a, i) => `${i + 1}. ${a.title} — ${a.one_liner} (${a.minutes} min, ${a.difficulty})`)
                .join("\n");
              const { data } = await ctx.run(SHELF_PICK,
                `UNREAD:\n${pool}\n\nTHEY SAID:\n"${query}"`, { signal });
              return { ...data, article: (unread.length ? unread : all)[data.pick - 1] };
            },
            summarize: (r) => `picked: ${r.article?.title}`,
          },
          {
            name: "reflect_on_habits",
            description: "Say what their saving-versus-reading habits reveal. Use when they ask about themselves.",
            run: async () => {
              const stats = habitStats(all);
              const { data } = await ctx.run(MIRROR,
                `SAVED BY TOPIC: ${stats.savedLine}\nREAD BY TOPIC: ${stats.readLine}\n` +
                `TOTAL SAVED: ${all.length}\nTOTAL READ: ${stats.readCount}`, { signal });
              return { ...data, stats };
            },
            summarize: (r) => r.observation,
          },
        ];

        const { results } = await runLoop({
          goal: `Answer this about their reading pile: "${query}"`,
          tools,
          maxSteps: 4,
          modelId: ctx.modelId(),
          signal,
          onStep: trail.fromStep,
        });

        renderAnswer(results);
      });
    }

    function renderAnswer(results) {
      const nodes = [];
      const found = results.find_by_description;
      const picked = results.pick_for_time;
      const mirror = results.reflect_on_habits;

      if (found?.found && found.article) {
        nodes.push(articleCard(found.article, "This one", found.because));
      } else if (found && !found.found) {
        nodes.push(el("section.panel", {},
          el("span.pill.pill-warn", { text: "Not on the shelf" }),
          el("p.muted", { style: { marginTop: "10px" },
            text: "Nothing here matches that. The librarian is allowed to say no rather than hand you the wrong article." })));
      }

      if (picked?.article) {
        nodes.push(articleCard(picked.article, "Read this now", picked.because));
        if (picked.not_now) {
          nodes.push(el("section.panel.panel-tight", {},
            el("span.pill", { text: "Deliberately not today" }),
            el("p.muted", { style: { marginTop: "8px" }, text: picked.not_now })));
        }
      }

      if (mirror) {
        nodes.push(el("section.panel", {},
          el("span.pill.pill-accent", { text: "The mirror" }),
          el("h2", { style: { margin: "12px 0 12px" }, text: mirror.observation }),
          el("div.stat-row", {},
            el("div.stat", {}, el("div.n", { text: mirror.stats.readCount }), el("div.k", { text: "read" })),
            el("div.stat", {}, el("div.n", { text: mirror.stats.total }), el("div.k", { text: "saved" })),
            el("div.stat", {}, el("div.n", { text: `${mirror.stats.rate}%` }), el("div.k", { text: "actually read" }))),
          el("div.row", { style: { marginTop: "16px" } },
            mirror.saves_but_avoids && el("span.pill.pill-warn", { text: `Hoards: ${mirror.saves_but_avoids}` }),
            mirror.actually_reads && el("span.pill.pill-good", { text: `Reads: ${mirror.actually_reads}` }))));
      }

      if (!nodes.length) {
        nodes.push(el("section.panel", {},
          el("p.muted", { text: "The loop finished without settling on an answer. Rephrasing usually fixes it." })));
      }

      fill(answerEl, nodes);
    }

    function articleCard(a, badge, why) {
      return el("section.panel", {},
        el("span.pill.pill-accent", { text: badge }),
        el("h2", { style: { margin: "12px 0 6px" }, text: a.title }),
        el("p.muted", { text: a.one_liner }),
        why && el("p", { style: { marginTop: "10px" }, text: why }),
        el("div.task-meta", { style: { marginTop: "12px" } },
          el("span.pill", { text: `${a.minutes} min` }),
          el("span.pill", { text: a.difficulty }),
          ...a.topics.slice(0, 4).map((t) => el("span.pill", { text: t }))),
        el("div.row", { style: { marginTop: "14px" } },
          el("button.btn.btn-sm", {
            onclick: () => { shelf.update(a.id, { read: !a.read }); render(); ctx.toast(a.read ? "Marked unread." : "Marked read."); },
          }, a.read ? "Mark unread" : "Mark as read")));
    }

    /* ---------------- shelf ---------------- */

    function render() {
      const all = shelf.all();
      if (!all.length) {
        return fill(shelfEl, el("div.empty", {},
          el("div.big", { text: "\u{1F4D6}" }),
          el("p", { text: "Empty shelf. Paste an article to start the pile you'll feel guilty about." })));
      }

      const stats = habitStats(all);
      fill(shelfEl,
        el("div.row", { style: { marginBottom: "14px" } },
          el("span.pill", { text: `${all.length} saved` }),
          el("span.pill", { text: `${stats.readCount} read` }),
          el("span", { class: `pill ${stats.rate < 30 ? "pill-warn" : "pill-good"}`,
            text: `${stats.rate}% of what you save` })),
        all.map((a) => el("div.card", {},
          el("div.row", {},
            el("strong", { text: a.title }),
            el("span.spacer"),
            a.read && el("span.pill.pill-good", { text: "read" }),
            el("span.dim.small", { text: ago(a.at) })),
          el("p.muted.small", { style: { margin: "7px 0 0" }, text: a.one_liner }),
          el("div.task-meta", {},
            el("span.pill", { text: `${a.minutes} min` }),
            ...a.topics.slice(0, 3).map((t) => el("span.pill", { text: t })),
            el("button.btn.btn-ghost.btn-sm", {
              onclick: () => { shelf.remove(a.id); render(); },
            }, "Remove")))));
    }
  },
};

function habitStats(all) {
  const savedBy = new Map();
  const readBy = new Map();
  for (const a of all) {
    for (const t of a.topics) {
      savedBy.set(t, (savedBy.get(t) ?? 0) + 1);
      if (a.read) readBy.set(t, (readBy.get(t) ?? 0) + 1);
    }
  }
  const top = (m) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6)
    .map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  const readCount = all.filter((a) => a.read).length;
  return {
    total: all.length,
    readCount,
    rate: all.length ? Math.round((readCount / all.length) * 100) : 0,
    savedLine: top(savedBy),
    readLine: top(readBy),
  };
}
