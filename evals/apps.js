/**
 * App-level evals: latency and accuracy.
 *
 * The golden set in run.js asks whether the twelve agents classify correctly.
 * This asks a different question: how long does an actual app take, and does
 * the chain behind it hold together. Those are separate concerns - an agent can
 * be perfectly accurate and still make an app unusable, because the app runs
 * three of them in sequence and a person is watching.
 *
 * Latency is reported per agent call and per app, because the two numbers lead
 * to different fixes: a slow agent wants a smaller max_tokens, a slow app wants
 * fewer calls.
 */

import { BRAINDUMP, NEXT_ACTION, JOURNAL_READ, JOURNAL_PATTERN,
         SHELF_READ, LIBRARIAN, SHELF_PICK, TASTE, PICK } from "../src/app-agents.js";
import { runAgent } from "../src/runtime.js";

/** A checker returns [] on pass, or reasons on fail. */
const ok = () => [];
const fail = (m) => [m];

const ARTICLE =
  "Why teams get slower as they grow. Adding people to a software team does not add " +
  "throughput linearly, and past a certain size it subtracts. The reason is that " +
  "coordination cost grows with the square of headcount while output grows at best " +
  "linearly. Every new engineer adds n-1 new communication paths. Teams that stay fast " +
  "do it by reducing the number of people who must agree before something ships, not by " +
  "hiring more carefully. The practical lever is autonomy: small teams that own a surface " +
  "end to end ship faster than larger teams that must coordinate.";

const JOURNAL_ENTRY =
  "Long day. Shipped the export fix finally, which Ana had been waiting on for two weeks. " +
  "Ben helped debug the timeout. I'm tired but it feels good to have it closed out. " +
  "Still worried about the migration next month - nobody has owned it yet and I think " +
  "that will land on me.";

export const SUITES = [
  {
    app: "Braindump",
    steps: [
      {
        agent: BRAINDUMP,
        input:
          "gotta call mum this week, ship the deck by fri, ben still owes me that invoice " +
          "from march, book dentist sometime, and I really need to cancel the gym before " +
          "they bill me again",
        check: (d) => {
          const out = [];
          if (d.tasks.length < 4) out.push(`only ${d.tasks.length} tasks from 5 items`);
          // realign() runs inside runAgent, so by here the columns must match.
          for (const k of ["owners", "due_dates", "priorities", "projects", "minutes"]) {
            if (d[k].length !== d.tasks.length) out.push(`${k} not aligned to tasks`);
          }
          if (!d.tasks.some((t) => /gym/i.test(t))) out.push("lost the gym task");
          return out;
        },
      },
      {
        agent: NEXT_ACTION,
        input:
          "MY LIST:\n1. Call mum — family, due this week (soon, about 15 min)\n" +
          "2. Ship the deck — work, due friday (now, about 60 min)\n" +
          "3. Chase Ben for the invoice — money, due someday (someday, about 10 min)",
        check: (d) => (d.pick >= 1 && d.pick <= 3 ? ok() : fail(`pick ${d.pick} out of range`)),
      },
    ],
  },
  {
    app: "Journal",
    steps: [
      {
        agent: JOURNAL_READ,
        input: JOURNAL_ENTRY,
        check: (d) => {
          const out = [];
          const names = d.people.join(" ").toLowerCase();
          if (!names.includes("ana") && !names.includes("ben")) out.push("missed both names");
          if (!d.worries.length) out.push("missed the stated worry about the migration");
          if (typeof d.mood_score !== "number" || d.mood_score < 0 || d.mood_score > 5) {
            out.push(`mood_score ${d.mood_score} outside 0-5`);
          }
          return out;
        },
      },
      {
        agent: JOURNAL_PATTERN,
        input:
          "ENTRIES:\n1 Mar — tired (2/5): shipped a fix, worried about the migration\n" +
          "3 Mar — tired (2/5): long day, migration still unowned\n" +
          "6 Mar — anxious (2/5): asked about the migration again, no answer",
        // Either answer is defensible; inventing a pattern from nothing is not.
        check: (d) => (d.found && !d.pattern ? fail("found=true with empty pattern") : ok()),
      },
    ],
  },
  {
    app: "The Pile",
    steps: [
      {
        agent: SHELF_READ,
        input: ARTICLE,
        check: (d) => {
          const out = [];
          if (!d.topics.length) out.push("no topics");
          if (!(d.minutes >= 1)) out.push(`minutes ${d.minutes} not positive`);
          if (!["easy", "medium", "heavy"].includes(d.difficulty)) out.push("difficulty off-enum");
          return out;
        },
      },
      {
        agent: LIBRARIAN,
        input:
          "SHELF:\n1. Sourdough starters — how to keep one alive [baking] (6 min, easy, unread)\n" +
          "2. Why teams get slower as they grow — coordination cost rises with headcount " +
          "[engineering, teams] (9 min, medium, unread)\n" +
          "3. A history of the shipping container [logistics] (14 min, medium, read)\n\n" +
          'THEY REMEMBER:\n"the one about why big teams slow down"',
        // The whole point of this agent: match on meaning, not on shared words.
        check: (d) => (d.found && d.pick === 2 ? ok() : fail(`picked ${d.pick}, expected 2`)),
      },
      {
        agent: SHELF_PICK,
        input:
          "UNREAD:\n1. Why teams get slower as they grow (9 min, medium)\n" +
          "2. A history of the shipping container (34 min, heavy)\n\n" +
          'THEY SAID:\n"I have 10 minutes and low energy"',
        check: (d) => (d.pick === 1 ? ok() : fail(`picked the ${d.pick === 2 ? "34-minute heavy" : "unknown"} one`)),
      },
    ],
  },
  {
    app: "Recommend Me",
    steps: [
      {
        agent: TASTE,
        input: "a book about how cities actually work",
        check: (d) => {
          const out = [];
          if (!d.queries.length) out.push("no queries");
          // The failure this agent actually has: echoing the sentence back.
          const long = d.queries.filter((q) => q.trim().split(/\s+/).length > 3);
          if (long.length) out.push(`queries are phrases not keywords: ${long.join(" | ")}`);
          if (d.queries.some((q) => /\blike\b|\bsimilar\b/i.test(q))) out.push('used "like X"');
          if (!d.wants.includes("book")) out.push(`wants ${d.wants.join(",")} — they said book`);
          return out;
        },
      },
      {
        agent: PICK,
        input:
          'THEY ASKED FOR: "a book about how cities actually work"\n\nCANDIDATES:\n' +
          "1. [book] The Death and Life of Great American Cities (1961) — Jane Jacobs\n" +
          "2. [book] Sourdough (2017) — Robin Sloan\n" +
          "3. [book] Order Without Design (2018) — Alain Bertaud\n" +
          "4. [book] The Power Broker (1974) — Robert Caro\n" +
          "5. [film] Fast Five (2011)",
        check: (d) => {
          const out = [];
          const picks = [d.pick_1, d.pick_2, d.pick_3];
          const chosen = picks.filter((n) => n >= 1);
          if (!chosen.length) out.push("picked nothing");
          if (chosen.some((n) => n > 5)) out.push(`index out of range: ${chosen.join(",")}`);
          if (chosen.includes(5)) out.push("picked a film for a book request");
          if (chosen.length && !d.why_1) out.push("no reason given for the top pick");
          return out;
        },
      },
    ],
  },
];

/** Run everything, reporting each step as it lands. */
export async function runAppEvals({ modelId, onStep = () => {} } = {}) {
  const rows = [];

  for (const suite of SUITES) {
    for (const step of suite.steps) {
      const started = performance.now();
      let failures = [];
      let tps = 0;
      let tokens = 0;

      try {
        const result = await runAgent(step.agent, step.input, { modelId });
        failures = step.check(result.data) ?? [];
        tps = result.tokensPerSecond;
        tokens = result.completionTokens;
        if (result.issues.length) {
          failures.push(...result.issues.map((i) => `${i.kind}: ${i.detail}`));
        }
      } catch (err) {
        failures = [`threw: ${err.message}`];
      }

      const row = {
        app: suite.app,
        agent: step.agent.id,
        ms: performance.now() - started,
        tps,
        tokens,
        pass: failures.length === 0,
        failures,
      };
      rows.push(row);
      onStep(row);
    }
  }

  return { rows, summary: summarise(rows) };
}

function summarise(rows) {
  const byApp = new Map();
  for (const r of rows) {
    const a = byApp.get(r.app) ?? { app: r.app, ms: 0, steps: 0, passed: 0 };
    a.ms += r.ms;
    a.steps++;
    if (r.pass) a.passed++;
    byApp.set(r.app, a);
  }
  return {
    apps: [...byApp.values()],
    passed: rows.filter((r) => r.pass).length,
    total: rows.length,
    medianTps: median(rows.map((r) => r.tps).filter(Boolean)),
    totalMs: rows.reduce((s, r) => s + r.ms, 0),
  };
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
