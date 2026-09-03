/**
 * Is This a Scam? - paste the text, get a straight answer.
 *
 * A real agent loop, and one where the tool split is the point: some checks are
 * judgement and some are arithmetic. Whether a message "feels" like a scam is a
 * language problem the model handles. Whether `hmrc-refund-claim.co` is the real
 * HMRC domain is not - it is string comparison, and a 1.5B model asked to do it
 * will guess. So link inspection is plain JavaScript, the verdict is the model,
 * and the planner decides what to run.
 *
 * The output is written for someone who is frightened and in a hurry, which is
 * the actual reading condition for this app. No jargon, no hedging into
 * uselessness, and a clear first step if they have already clicked.
 */

import { el, fill, titleCase } from "../dom.js";
import { SCAM_CHECK, SCAM_SURFACE } from "../app-agents.js";
import { runLoop } from "../orchestrator.js";

const SAMPLE =
  "HMRC: You are eligible for a refund of £284.50 following your latest tax assessment. " +
  "Submit your claim within 24hrs to avoid forfeit: http://hmrc-refund-claim.co/gov-uk";

/** Legitimate organisations do not send you these. Cheap, deterministic signals. */
const SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly"];
const BRANDS = ["hmrc", "paypal", "amazon", "apple", "netflix", "dhl", "fedex", "usps", "royalmail",
  "gov", "irs", "microsoft", "google", "santander", "barclays", "hsbc", "natwest", "chase", "wells"];

export default {
  id: "scam",
  name: "Is This a Scam?",
  icon: "scam",
  blurb: "Paste the text about the parcel, the refund, or the new number. Get a straight answer.",
  tag: "Agent loop: model judgement + deterministic link checks",

  mount(root, ctx) {
    const input = el("textarea.field", {
      rows: 5,
      placeholder: "Paste the message exactly as it arrived — including the link.",
    });
    const out = el("div");
    const trail = ctx.trail();

    const goBtn = el("button.btn.btn-primary", { onclick: go }, "Check this message");
    const sampleBtn = el("button.btn.btn-ghost.btn-sm", {
      onclick: () => (input.value = SAMPLE),
    }, "Use an example");

    root.append(
      el("section.panel", {},
        el("label.label", { text: "The message" }),
        input,
        el("div.row", { style: { marginTop: "14px" } }, goBtn, sampleBtn)),
      trail.node,
      out
    );

    async function go() {
      const text = input.value.trim();
      if (!text) return ctx.toast("Paste the message first.");

      await ctx.busy(goBtn, async (signal) => {
        trail.reset();
        fill(out);

        let surfaced = null;
        let linkReport = null;

        const tools = [
          {
            name: "read_the_message",
            description: "Pull out the links, phone numbers, who it claims to be from, and any deadline.",
            run: async () => {
              const { data } = await ctx.run(SCAM_SURFACE, text, { signal });
              surfaced = data;
              return data;
            },
            summarize: (d) =>
              `claims to be ${d.claims_to_be}; ${d.links.length} link(s); asks you to ${d.asks_you_to}`,
          },
          {
            name: "inspect_links",
            description: "Check the web addresses for lookalike domains, shorteners and raw IPs. Needs read_the_message first.",
            run: async () => {
              const links = surfaced?.links ?? extractUrls(text);
              linkReport = links.map(inspect);
              return linkReport;
            },
            summarize: (r) =>
              r.length ? r.map((x) => `${x.raw}: ${x.flags.join(", ") || "nothing obviously wrong"}`).join(" | ")
                       : "no links in this message",
          },
          {
            name: "judge",
            description: "Make the final call and say what to do about it. Run this last.",
            run: async () => {
              const evidence = [
                surfaced ? `CLAIMS TO BE: ${surfaced.claims_to_be}\nDEADLINE: ${surfaced.deadline}\nASKS YOU TO: ${surfaced.asks_you_to}` : "",
                linkReport?.length
                  ? `LINK CHECKS:\n${linkReport.map((r) => `${r.raw} — ${r.flags.join("; ") || "no automated flags"}`).join("\n")}`
                  : "",
              ].filter(Boolean).join("\n\n");

              const { data } = await ctx.run(
                SCAM_CHECK,
                evidence ? `${text}\n\n--- CHECKS ALREADY RUN ---\n${evidence}` : text,
                { signal }
              );
              return data;
            },
            summarize: (d) => `${d.verdict} (${Math.round(d.confidence * 100)}%)`,
          },
        ];

        const { results } = await runLoop({
          goal:
            "Decide whether this message is a scam and tell the person plainly what to do. " +
            "Read the message, check any links, then judge.",
          tools,
          maxSteps: 5,
          modelId: ctx.modelId(),
          signal,
          onStep: trail.fromStep,
        });

        const verdict = results.judge;
        if (!verdict) {
          return fill(out, el("section.panel", {},
            el("p.muted", { text: "The loop finished without reaching a verdict. Try again — small models occasionally stop early." })));
        }

        render(verdict, linkReport);
      });
    }

    function render(d, links) {
      const tone = { almost_certainly_a_scam: "bad", probably_a_scam: "bad",
                     cant_tell: "warn", probably_genuine: "good" }[d.verdict] ?? "warn";

      // Small models reach for a citation when asked to summarise, and a
      // fabricated URL sitting where the verdict should be is the worst
      // possible output for this particular app - it looks like a source.
      const headline = /https?:\/\/|www\.|\.(com|co|net|org|uk)\b/i.test(d.in_one_line)
        ? FALLBACK_LINE[d.verdict] ?? verdictLabel(d.verdict)
        : d.in_one_line;

      fill(out,
        el("section.panel", {},
          el("div.row", {},
            el("span", { class: `pill pill-${tone}`, text: verdictLabel(d.verdict) }),
            el("span.pill", { text: `${Math.round(d.confidence * 100)}% sure` }),
            el("span.pill", { text: `They want: ${titleCase(d.they_want)}` })),
          el("h2", { style: { marginTop: "18px" }, text: headline })),

        d.tells.length > 0 && el("section.panel", {},
          el("label.label", { text: "What gives it away" }),
          el("div.stack", {}, d.tells.map((t) =>
            el("div.card", { style: { borderLeft: `2px solid var(--${tone === "good" ? "good" : "bad"})` }, text: t })))),

        links?.length > 0 && el("section.panel", {},
          el("label.label", { text: "The links, checked" }),
          el("div.stack", {}, links.map((l) =>
            el("div.card", {},
              el("div.mono", { text: l.raw }),
              el("div.task-meta", {}, l.flags.length
                ? l.flags.map((f) => el("span.pill.pill-bad", { text: f }))
                : el("span.pill.pill-good", { text: "nothing automated to flag" })))))),

        d.do_this.length > 0 && el("section.panel", {},
          el("label.label", { text: "Do this" }),
          el("ol", { style: { margin: 0, paddingLeft: "20px", lineHeight: "1.8" } },
            d.do_this.map((s) => el("li", { text: s }))),
          d.if_you_already_clicked && el("div.card", { style: { marginTop: "14px" } },
            el("strong.small", { text: "If you already clicked" }),
            el("p", { style: { margin: "6px 0 0" }, class: "muted", text: d.if_you_already_clicked })))
      );
    }
  },
};

/* ------------------------------------------------------------------ *
 * link inspection - deterministic, because this part is not a judgement call
 * ------------------------------------------------------------------ */

function extractUrls(text) {
  return text.match(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi) ?? [];
}

function inspect(raw) {
  const flags = [];
  let host = "";
  try {
    host = new URL(raw.startsWith("http") ? raw : `http://${raw}`).hostname.toLowerCase();
  } catch {
    return { raw, flags: ["could not be parsed as a web address"] };
  }

  const parts = host.split(".");
  const tld = parts.at(-1);
  const registered = parts.slice(-2).join(".");

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) flags.push("a bare IP address, not a domain name");
  if (host.startsWith("xn--") || parts.some((p) => p.startsWith("xn--"))) {
    flags.push("uses look-alike foreign characters");
  }
  if (SHORTENERS.includes(registered)) flags.push("a link shortener hiding the real destination");
  if (!raw.toLowerCase().startsWith("https")) flags.push("not a secure (https) address");

  // A brand name that appears anywhere but the registered domain is the single
  // most reliable signal in this whole file: `hmrc-refund.co` is not HMRC, and
  // `secure-paypal.example.com` is not PayPal.
  for (const brand of BRANDS) {
    if (!host.includes(brand)) continue;
    const owns = registered === `${brand}.com` || registered === `${brand}.co.uk` ||
                 registered.endsWith(`.${brand}.com`) || host.endsWith(`.${brand}.gov.uk`) ||
                 registered === `${brand}.gov.uk` || registered === `${brand}.gov`;
    if (!owns) flags.push(`pretends to be ${brand} — the real address does not look like this`);
    break;
  }

  if (parts.length > 3) flags.push("unusually deep subdomains, often used to bury the real one");
  if (["zip", "mov", "top", "xyz", "click", "link", "gq", "tk", "cf"].includes(tld)) {
    flags.push(`.${tld} is a cheap domain ending heavily used for fraud`);
  }

  return { raw, host, flags };
}

/** Used when the model puts a link where a sentence belongs. */
const FALLBACK_LINE = {
  almost_certainly_a_scam: "This is a scam. Do not click the link, and do not reply.",
  probably_a_scam: "This looks like a scam. Do not click the link — check with the company directly.",
  cant_tell: "There is not enough here to be sure. Treat it as suspicious until you have checked.",
  probably_genuine: "Nothing here looks like a scam, but check with the company if money is involved.",
};

const verdictLabel = (v) => ({
  almost_certainly_a_scam: "Almost certainly a scam",
  probably_a_scam: "Probably a scam",
  cant_tell: "Can't tell for sure",
  probably_genuine: "Probably genuine",
}[v] ?? v);
