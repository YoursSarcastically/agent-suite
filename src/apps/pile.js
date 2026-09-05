/**
 * Reading List - save articles, then find them by describing them.
 *
 * The point is the search. You remember what an article was about long after
 * you have forgotten its title, its author and the site it was on, so keyword
 * search over saved articles mostly fails when you need it. Here the model
 * reads a summary of everything saved and matches on meaning instead.
 *
 * That is the model reading an index, not embeddings. It is slower and it will
 * not scale past a few hundred articles, but it needs no second model download
 * and it fails honestly: the matcher can return found=false rather than
 * confidently handing back the wrong article.
 */

import { el, fill, ago } from "../dom.js";
import { SHELF_READ, LIBRARIAN, SHELF_PICK, MIRROR } from "../app-agents.js";
import { runLoop } from "../orchestrator.js";
import { collection } from "../store.js";
import { fetchArticle, looksLikeUrl, networkLog } from "../catalog.js";

const shelf = collection("pile:articles", { cap: 250 });

/** Stand-in title until the model produces a real one. */
const firstLine = (text) => {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "Untitled";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};

/** ~230 words a minute, which is close enough to be useful before summarising. */
const estimateMinutes = (text) =>
  Math.max(1, Math.round(text.trim().split(/\s+/).length / 230));

export default {
  id: "pile",
  name: "Reading List",
  icon: "pile",
  blurb: "Save articles, then find them by what they were about",


  mount(root, ctx) {
    const paste = el("textarea.field", {
      rows: 4,
      placeholder: "Paste a link, or the full text of an article",
    });
    const ask = el("input.field", {
      type: "text",
      placeholder: "Describe what it was about",
    });
    const answerEl = el("div");
    const shelfEl = el("div.stack");
    const trail = ctx.trail();
    const netEl = el("div");

    const saveBtn = el("button.btn.btn-primary", { onclick: save }, "Save article");
    // Not `onclick: askShelf` - a handler is called with the Event, which would
    // arrive as `preset` and be searched for as the string "[object PointerEvent]".
    const askBtn = el("button.btn.btn-primary", { onclick: () => askShelf() }, "Search");
    const timeBtn = el("button.btn", { onclick: () => askShelf("I have 10 minutes and not much energy") },
      "What should I read now?");
    const mirrorBtn = el("button.btn", { onclick: () => askShelf("what do I save but never read") },
      "What do I actually read?");

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

    // Declared before render(), which reaches for it. `const` is not hoisted, so
    // the other order throws in the temporal dead zone and the app mounts blank.
    const findPanel = el("section.panel", { hidden: shelf.count() === 0 },
      el("label.label", { text: "Find an article" }),
      ask,
      el("div.row", { style: { marginTop: "14px" } }, askBtn, timeBtn, mirrorBtn));

    render();

    root.append(
      el("section.panel", {},
        el("label.label", { text: "Save an article" }),
        paste,
        el("div.row", { style: { marginTop: "14px" } }, saveBtn,
          el("span.small.dim", { text: "or drag a .txt file onto this page" })),
        el("p.small.dim", { style: { marginTop: "12px" },
          text: "Pasted text stays on your machine. Pasting a link sends just that " +
                "address to a reader service so the page can be fetched." })),
      findPanel,
      trail.node,
      answerEl,
      el("section.panel", {}, el("label.label", { text: "Saved articles" }), shelfEl),
      netEl
    );

    /* ---------------- filing ---------------- */

    async function save() {
      const raw = paste.value.trim();
      const isUrl = looksLikeUrl(raw);
      if (!isUrl && raw.length < 120) {
        return ctx.toast("That is too short. Paste a link, or the whole article.");
      }

      // Fetching is quick; summarising is not. So the article joins the list as
      // soon as there is something to show, and the model catches up in the
      // background - you can paste five links in a row rather than waiting
      // thirty seconds between each.
      let entry;
      await ctx.busy(saveBtn, async (signal) => {
        trail.reset();

        let text = raw;
        let source = "";
        let title = "";

        if (isUrl) {
          trail.plan("fetch", "Fetching the page");
          try {
            const page = await fetchArticle(raw, { signal });
            text = page.title ? `${page.title}\n\n${page.text}` : page.text;
            source = page.url;
            title = page.title;
            trail.done("fetch", page.title || "Page fetched");
          } catch (err) {
            if (err.name === "AbortError") return;
            trail.warn("fetch", err.message);
            return ctx.toast(`${err.message} — try pasting the text instead.`);
          }
          if (text.replace(/\s+/g, " ").length < 200) {
            return ctx.toast("That page had almost no readable text — it may need a login.");
          }
        }

        entry = shelf.add({
          title: title || firstLine(text),
          one_liner: "",
          topics: [],
          claims: [],
          answers: "",
          minutes: estimateMinutes(text),
          difficulty: "medium",
          text: text.slice(0, 20000),
          source,
          read: false,
          pending: true,
        });

        paste.value = "";
        render();
        renderNetwork();
      });

      // Deliberately not awaited: the engine serialises requests anyway, so
      // several of these queue up behind each other without blocking the page.
      if (entry) summarise(entry);
    }

    /** Fill in the summary for an article already on the list. */
    async function summarise(entry) {
      try {
        // The opening is where the argument lives; the tail is usually
        // related-links furniture, and the whole thing will not fit regardless.
        const { data } = await ctx.run(SHELF_READ, entry.text.slice(0, 6000));
        shelf.update(entry.id, { ...data, pending: false });
      } catch (err) {
        if (err.name === "AbortError") return;
        shelf.update(entry.id, { pending: false, one_liner: "Could not summarise this one." });
      } finally {
        render();
      }
    }

    /* ---------------- the loop ---------------- */

    async function askShelf(preset) {
      const query = preset ?? ask.value.trim();
      if (!query) return ctx.toast("Type what the article was about.");

      const all = shelf.all();
      if (!all.length) return ctx.toast("Save an article first.");

      await ctx.busy(preset ? undefined : askBtn, async (signal) => {
        trail.reset();
        fill(answerEl);

        const index = all
          .filter((a) => !a.pending)
          .map((a, i) => `${i + 1}. ${a.title} — ${a.one_liner} [${a.topics.join(", ")}] ` +
            `(${a.minutes} min, ${a.difficulty}, ${a.read ? "read" : "unread"})`)
          .join("\n");

        const tools = [
          {
            name: "find_by_description",
            description: "Find a saved article from a description of it. Use when they describe an article.",
            run: async () => {
              const { data } = await ctx.run(LIBRARIAN,
                `SHELF:\n${index}\n\nTHEY REMEMBER:\n"${query}"`, { signal });
              return data.found ? { ...data, article: all[data.pick - 1] } : { found: false };
            },
            summarize: (r) => (r.found ? `Found: ${r.article?.title}` : "No saved article matches that"),
          },
          {
            name: "pick_for_time",
            description: "Pick one article to read now. Use when they mention time or energy.",
            run: async () => {
              const unread = all.filter((a) => !a.read);
              const pool = (unread.length ? unread : all)
                .map((a, i) => `${i + 1}. ${a.title} — ${a.one_liner} (${a.minutes} min, ${a.difficulty})`)
                .join("\n");
              const { data } = await ctx.run(SHELF_PICK,
                `UNREAD:\n${pool}\n\nTHEY SAID:\n"${query}"`, { signal });
              return { ...data, article: (unread.length ? unread : all)[data.pick - 1] };
            },
            summarize: (r) => `Suggests: ${r.article?.title}`,
          },
          {
            name: "reflect_on_habits",
            description: "Describe what they save versus what they read. Use when they ask about their habits.",
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
        nodes.push(articleCard(found.article, "Best match", found.because));
      } else if (found && !found.found) {
        nodes.push(el("section.panel", {},
          el("span.pill.pill-warn", { text: "No match" }),
          el("p.muted", { style: { marginTop: "10px" },
            text: "None of your saved articles match that description." })));
      }

      if (picked?.article) {
        nodes.push(articleCard(picked.article, "Read this next", picked.because));
        if (picked.not_now) {
          nodes.push(el("section.panel.panel-tight", {},
            el("span.pill", { text: "Skip for now" }),
            el("p.muted", { style: { marginTop: "8px" }, text: picked.not_now })));
        }
      }

      if (mirror) {
        nodes.push(el("section.panel", {},
          el("span.pill.pill-accent", { text: "Your reading habits" }),
          el("h2", { style: { margin: "12px 0 12px" }, text: mirror.observation }),
          el("div.stat-row", {},
            el("div.stat", {}, el("div.n", { text: mirror.stats.readCount }), el("div.k", { text: "read" })),
            el("div.stat", {}, el("div.n", { text: mirror.stats.total }), el("div.k", { text: "saved" })),
            el("div.stat", {}, el("div.n", { text: `${mirror.stats.rate}%` }), el("div.k", { text: "of saved, read" }))),
          el("div.row", { style: { marginTop: "16px" } },
            mirror.saves_but_avoids && el("span.pill.pill-warn", { text: `Saves but skips: ${mirror.saves_but_avoids}` }),
            mirror.actually_reads && el("span.pill.pill-good", { text: `Actually reads: ${mirror.actually_reads}` }))));
      }

      if (!nodes.length) {
        nodes.push(el("section.panel", {},
          el("p.muted", { text: "No answer this time. Rephrasing the question usually helps." })));
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
            onclick: () => { shelf.update(a.id, { read: !a.read }); render(); ctx.toast(a.read ? "Marked as unread." : "Marked as read."); },
          }, a.read ? "Mark unread" : "Mark as read")));
    }

    /* ---------------- shelf ---------------- */

    function renderNetwork() {
      if (!networkLog.length) return fill(netEl);
      fill(netEl, el("details.net", {},
        el("summary", { text: `${networkLog.length} page${networkLog.length === 1 ? "" : "s"} fetched — see exactly what was requested` }),
        el("ul", {}, networkLog.map((r) => el("li", { text: r.failed ? `${r.url} — ${r.note}` : r.url })))));
    }

    function render() {
      const all = shelf.all();
      findPanel.hidden = all.length === 0;
      if (!all.length) {
        return fill(shelfEl, el("div.empty", {},
          el("div.big", { text: "\u{1F4D6}" }),
          el("p", { text: "No articles saved yet." })));
      }

      const stats = habitStats(all);
      fill(shelfEl,
        el("div.row", { style: { marginBottom: "14px" } },
          el("span.pill", { text: `${all.length} saved` }),
          el("span.pill", { text: `${stats.readCount} read` }),
          el("span", { class: `pill ${stats.rate < 30 ? "pill-warn" : "pill-good"}`,
            text: `${stats.rate}% read` })),
        all.map((a) => el(`div.card${a.pending ? ".card-pending" : ""}`, {},
          el("div.row", {},
            el("strong", { text: a.title }),
            el("span.spacer"),
            a.pending && el("span.pill", { text: "Summarising…" }),
            !a.pending && a.read && el("span.pill.pill-good", { text: "read" }),
            el("span.dim.small", { text: ago(a.at) })),
          el("p.muted.small", { style: { margin: "7px 0 0" },
            text: a.pending ? "Reading it now — you can carry on adding links." : a.one_liner }),
          el("div.task-meta", {},
            el("span.pill", { text: `${a.minutes} min` }),
            ...a.topics.slice(0, 3).map((t) => el("span.pill", { text: t })),
            a.source && el("a.small", { href: a.source, target: "_blank",
              rel: "noopener noreferrer", text: "Open ↗" }),
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
