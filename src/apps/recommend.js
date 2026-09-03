/**
 * Recommend Me - describe a mood, get things to watch and read.
 *
 * The interesting constraint here is what the model is NOT allowed to do. Ask a
 * 1.5B model to name films and it will invent them - right shape, right era,
 * plausible director, does not exist. Recall is the single thing small models
 * are worst at, and no prompt fixes it.
 *
 * So the job splits along that line. The model turns "something like Nope but
 * funnier" into search phrases (rewriting - it is good at this), real
 * catalogues return real titles (iTunes, TVMaze, Open Library - no API keys, so
 * this stays a static site), and then the model ranks and explains what came
 * back (reading - also good at this). Every title on screen came from a
 * database, not from the weights.
 *
 * This app deliberately does NOT use the open planner loop the others do, and
 * the reason is a measurement rather than a preference. Given five tools, a
 * 1.5B planner searched films for a request that said "book", called the
 * ranking step before it had searched anything, and re-issued the same query
 * three times - roughly forty seconds of GPU time to arrive at Lovecraft
 * poetry for "how cities actually work". The decisions worth delegating here
 * are which catalogues and which words; the order of operations is four lines
 * of code that never gets them wrong. What remains genuinely agentic is the
 * retry: the ranking agent can declare the catalogue a poor match, and that
 * verdict sends the search back out with different words.
 *
 * This is also the one app that touches the network, so it says so, in the UI,
 * with the actual URLs. The claim is narrower here and stated plainly: your
 * taste never leaves the tab, only the search words do.
 */

import { el, fill } from "../dom.js";
import { TASTE, PICK, pickedFrom } from "../app-agents.js";
import { search, enrichFilms, forPrompt, networkLog, clearNetworkLog } from "../catalog.js";

const MEDIA_LABEL = { film: "films", show: "shows", book: "books" };

const dedupe = (xs) => [...new Set((xs ?? []).map((x) => String(x).trim()).filter(Boolean))];

/**
 * A catalogue search box wants keywords. Five or more words is a sentence, and
 * asking iTunes for "something like Nope but funnier" returns Fast Five - which
 * is exactly what the first live run did.
 */
const isKeywords = (s) => {
  const t = (s ?? "").trim();
  return t.length > 1 && t.split(/\s+/).length <= 4 && !/\bsimilar to\b|\blike\b/i.test(t);
};

/**
 * The slots hold numbers into a list the model was shown, and it will
 * occasionally name one that was never on it. A grammar cannot express "must be
 * a valid index", so the bound is checked rather than trusted.
 */
const valid = (chosen, pool) => pickedFrom(chosen, pool);

const SAMPLES = [
  "something like Nope but funnier",
  "a book about how cities actually work",
  "a show to watch while cooking, nothing that needs subtitles",
  "sad in a good way",
];

export default {
  id: "recommend",
  name: "Recommend Me",
  icon: "recommend",
  blurb: "Describe a mood, get films, shows and books",

  mount(root, ctx) {
    const input = el("input.field", { type: "text", placeholder: "e.g. something funny and not too long" });
    const out = el("div");
    const netEl = el("div");
    const trail = ctx.trail();

    const goBtn = el("button.btn.btn-primary", { onclick: go }, "Find me something");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

    root.append(
      el("section.panel", {},
        el("label.label", { text: "What are you in the mood for?" }),
        input,
        el("div.row", { style: { marginTop: "14px" } }, goBtn,
          ...SAMPLES.map((s) => el("button.btn.btn-ghost.btn-sm", {
            onclick: () => { input.value = s; go(); },
          }, s))),
        el("p.small.dim", { style: { marginTop: "14px" },
          text: "This app searches real film, TV and book catalogues, so every title is real." })),
      trail.node,
      out,
      netEl
    );

    async function go() {
      const mood = input.value.trim();
      if (!mood) return ctx.toast("Describe what you feel like watching or reading.");

      await ctx.busy(goBtn, async (signal) => {
        trail.reset();
        fill(out, skeletons());
        clearNetworkLog();

        const pool = [];
        const usedTerms = new Set();
        let chosen = null;
        let note = "";

        // Two rounds at most. The second only happens if the first produced a
        // genuinely poor match, which the ranking agent has to declare itself.
        for (let round = 1; round <= 2; round++) {
          trail.plan("plan_searches", round === 1
            ? "Working out what to search for"
            : "That did not fit — trying different search terms");

          const { data: plan } = await ctx.run(TASTE, note ? `${mood}\n\n${note}` : mood, { signal });

          const wants = dedupe(plan.wants).filter((w) => MEDIA_LABEL[w]);
          const media = wants.length ? wants : ["film", "show", "book"];
          const queries = dedupe([...plan.queries, mood].filter(isKeywords)).slice(0, 3);

          trail.done("plan_searches",
            `${media.map((m) => MEDIA_LABEL[m]).join(", ")} · ${queries.join(" · ") || mood}`);

          // Fan-out is deterministic. A 1.5B planner asked to sequence five
          // tools reaches for films when the request said books, calls the
          // ranking step before it has searched anything, and burns a full
          // generation per wrong turn. What is worth delegating here is which
          // catalogues and which words - not the order of operations.
          for (const medium of media) {
            const terms = (queries.length ? queries : [mood])
              .filter((t) => !usedTerms.has(`${medium}:${t}`));
            if (!terms.length) continue;

            trail.plan(`search_${medium}s`, `Searching real ${MEDIA_LABEL[medium]} for: ${terms.join(", ")}`);
            const before = pool.length;

            for (const term of terms) {
              usedTerms.add(`${medium}:${term}`);
              const hits = await search(medium, term, { limit: 5, signal });
              for (const hit of hits) {
                if (!pool.some((p) => p.title === hit.title && p.kind === hit.kind)) pool.push(hit);
              }
              renderNetwork();
            }

            const found = pool.length - before;
            trail.done(`search_${medium}s`, found
              ? `${found} new ${MEDIA_LABEL[medium]}: ${pool.slice(before, before + 4).map((p) => p.title).join(", ")}`
              : `nothing new in ${MEDIA_LABEL[medium]}`);
          }

          if (!pool.length) {
            note = "The searches returned nothing. Use broader, more common genre words.";
            continue;
          }

          trail.plan("choose", `Choosing from ${pool.length} real titles`);

          // The candidate list is the biggest thing in this prompt and the only
          // part that grows without bound, so it is capped before it can push
          // the generation past max_tokens.
          const shortlist = pool.slice(0, 10);

          // iTunes gives a title, a year and a one-word genre. That is thin
          // material to rank on, so the shortlist - and only the shortlist -
          // gets a real genre list, plot and IMDb rating before the model sees
          // it. Bounded on purpose: ten titles a search, cached, free tier.
          if (shortlist.some((it) => it.kind === "film")) {
            trail.plan("enrich", "Looking up ratings and plots");
            await enrichFilms(shortlist, { signal });
            renderNetwork();
          }
          const ask = (items, blurb) =>
            `THEY ASKED FOR: "${mood}"\n` +
            `${plan.vibe?.length ? `VIBE: ${plan.vibe.join(", ")}\n` : ""}` +
            `${plan.avoid?.length ? `AVOID: ${plan.avoid.join(", ")}\n` : ""}` +
            `\nCANDIDATES:\n${forPrompt(items, { blurb })}`;

          let data, issues;
          try {
            ({ data, issues } = await ctx.run(PICK, ask(shortlist, 110), { signal }));
          } catch (err) {
            if (!err.truncated) throw err;
            // One retry on half the list with no synopses at all. A shorter
            // prompt is a worse ranking and a much better outcome than an error.
            trail.plan("choose", "Too many options — narrowing the list");
            ({ data, issues } = await ctx.run(PICK, ask(pool.slice(0, 6), 0), { signal }));
          }
          if (issues.length) trail.warn("validate", issues[0].detail);

          chosen = data;
          const kept = valid(data, shortlist);
          trail.done("choose", kept.length
            ? `${kept.length} pick${kept.length === 1 ? "" : "s"}`
            : "nothing in the catalogue fits");

          // The retry is the agentic part that survived: the ranking agent is
          // allowed to say the catalogue did not have it, and that verdict
          // sends the loop back for different search words.
          if (data.good_match !== false && kept.length) break;
          note = `A search for "${queries.join('", "')}" returned titles that were not right. ` +
                 `Use completely different words — different genre, different theme.`;
        }

        render(chosen, pool);
        renderNetwork();
      });
    }

    function render(chosen, pool) {
      if (!pool.length) {
        return fill(out, el("section.panel", {},
          el("p.muted", { text: "Nothing came back. Try describing it differently — a genre or theme works better than a feeling." })));
      }

      const picks = valid(chosen, pool.slice(0, 10));
      const shown = picks.length ? picks : pool.slice(0, 6).map((item) => ({ item, why: "" }));

      fill(out,
        el("section.panel", {},
          el("div.row", { style: { marginBottom: "16px" } },
            el("span.pill.pill-accent", { text: `${shown.length} for you` }),
            el("span.pill", { text: `from ${pool.length} real titles` }),
            chosen && chosen.good_match === false &&
              el("span.pill.pill-warn", { text: "not a close match" })),
          el("div.media-grid", {}, shown.map(({ item, why }) =>
            el("div.media", {},
              el("span.kind", { text: item.kind }),
              el("span.title", { text: item.title }),
              el("span.meta", {
                text: [item.year, item.runtime, item.by, item.rating ? `★ ${item.rating}` : ""]
                  .filter(Boolean).join(" · "),
              }),
              why && el("span.why", { text: why }),
              item.link && el("a.small", { href: item.link, target: "_blank", rel: "noopener noreferrer",
                text: "More info ↗" }))))));
    }

    function renderNetwork() {
      if (!networkLog.length) return fill(netEl);
      fill(netEl, el("details.net", {},
        el("summary", { text: `${networkLog.length} search${networkLog.length === 1 ? "" : "es"} sent to the internet — see exactly what` }),
        el("p.small.muted", { style: { marginTop: "10px" },
          text: "What you typed was never sent. Only the search words, to three public catalogues." }),
        el("ul", {}, networkLog.map((r) =>
          el("li", { style: r.failed ? { opacity: "0.7" } : null },
            r.failed ? `${r.url} — ${r.note}` : r.url)))));
    }

    function skeletons() {
      return el("section.panel", {},
        el("div.media-grid", {}, Array.from({ length: 3 }, () =>
          el("div.media", {},
            el("div.skeleton.shimmer", { style: { width: "35%" } }),
            el("div.skeleton.shimmer", { style: { width: "80%", height: "17px" } }),
            el("div.skeleton.shimmer", { style: { width: "60%" } }),
            el("div.skeleton.shimmer", { style: { width: "92%" } })))));
    }
  },
};
