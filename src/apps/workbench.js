/**
 * The workbench - the original twelve agents, kept.
 *
 * The apps are the product now, but they are all assembled from these, and a
 * demo that cannot show its own parts is asking to be taken on faith. This page
 * is the proof that nothing above is hardcoded: same runtime, same constrained
 * decoding, raw JSON on screen, including the repairs and the alignment failures
 * when they happen.
 */

import { el, fill } from "../dom.js";
import { AGENTS, byId } from "../agents.js";

export default {
  id: "workbench",
  name: "Under the hood",
  icon: "workbench",
  blurb: "The twelve agents underneath",
  tag: "The original suite",

  mount(root, ctx) {
    const grid = el("div.agent-grid");
    const bench = el("div");
    let current = null;

    for (const agent of AGENTS) {
      grid.append(el("button.agent-card", { type: "button", onclick: () => open(agent.id) },
        el("span.ic", { text: agent.icon }),
        el("span.nm", { text: agent.name }),
        el("span.bl", { text: agent.blurb }),
        el("span.dim.small", { style: { marginTop: "6px" },
          text: `${Object.keys(agent.schema.properties).length} fields` })));
    }

    root.append(el("section.panel", {}, grid), bench);

    function open(id) {
      current = byId(id);
      const input = el("textarea.field", { rows: 7, spellcheck: false, value: current.sample });
      const output = el("pre.output", { text: "—" });
      const metrics = el("span.small.dim");
      const runBtn = el("button.btn.btn-primary", { onclick: run }, "Run agent");

      fill(bench, el("section.panel", {},
        el("div.row", {},
          el("h2", { text: `${current.icon}  ${current.name}` }),
          el("span.spacer"),
          el("button.btn.btn-ghost.btn-icon", { onclick: () => fill(bench), "aria-label": "Close" }, "✕")),
        el("p.muted", { style: { margin: "8px 0 0" }, text: current.blurb }),
        el("label.label", { style: { marginTop: "18px" }, text: "Input" }),
        input,
        el("div.row", { style: { marginTop: "14px" } },
          runBtn,
          el("button.btn", { onclick: () => (input.value = current.sample) }, "Reset to sample"),
          metrics),
        el("label.label", { style: { marginTop: "18px" }, text: "Output — schema-constrained JSON" }),
        output,
        el("p.small.dim", {
          text: `Decoding is constrained to: ${Object.keys(current.schema.properties).join(", ")}` })));

      bench.scrollIntoView({ behavior: "smooth", block: "start" });

      async function run() {
        const text = input.value.trim();
        if (!text) return ctx.toast("Give the agent something to work with.");

        await ctx.busy(runBtn, async (signal) => {
          output.textContent = "";
          const result = await ctx.run(current, text, {
            signal,
            onToken: (_, whole) => { output.textContent = whole; },
          });
          output.textContent = JSON.stringify(result.data, null, 2);

          const notes = [
            `${(result.elapsedMs / 1000).toFixed(1)}s`,
            `~${result.tokensPerSecond} tok/s`,
            "on-device",
            result.repairs.length > 0 && `⚠ ${result.repairs.length} clamped`,
            result.issues.length > 0 && `⚠ ${result.issues.map((i) => i.kind).join(", ")}`,
          ].filter(Boolean);
          metrics.textContent = notes.join(" · ");

          if (result.issues.length) {
            output.textContent +=
              `\n\n/* validation caught what the schema cannot express:\n` +
              result.issues.map((i) => `   ${i.kind}: ${i.detail}\n   ${i.message}`).join("\n") + `\n*/`;
          }
        });
      }
    }
  },
};
