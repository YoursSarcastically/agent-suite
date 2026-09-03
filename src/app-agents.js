/**
 * Agents for the six apps.
 *
 * Same rules as the original twelve, for the same reasons:
 *
 *   - Flat schemas only. Nested `array<object>` hangs the constrained decoder at
 *     this model size, so anything that wants to be a list of records is a set
 *     of index-aligned parallel arrays plus an `aligned` declaration that
 *     runtime.validate() enforces after decoding.
 *   - Enums wherever a field is a decision. A 1.5B model asked for a "mood" will
 *     invent "cautiously optimistic"; asked for one of six it cannot.
 *   - Nothing asks the model to *recall*. Small models are worst at knowing
 *     things and best at reshaping things put in front of them, so every agent
 *     here reads its input rather than its training data.
 */

const enumField = (values, description) => ({ type: "string", enum: values, description });
const list = (description) => ({ type: "array", items: { type: "string" }, description });
const score = (max, description) => ({ type: "number", minimum: 0, maximum: max, description });

/* ================================================================== *
 * Braindump
 * ================================================================== */

export const BRAINDUMP = {
  id: "braindump",
  temperature: 0,
  maxTokens: 700,
  system:
    "You turn a messy brain dump into concrete tasks. One task per thing the person actually has " +
    "to do. Keep their own words where you can - they will recognise their task faster than your " +
    "improved version of it. If no deadline is stated, say 'someday' rather than inventing Friday. " +
    "If no owner is stated the owner is 'me'. Do not add tasks they did not mention.",
  schema: {
    type: "object",
    properties: {
      tasks: list("The action, in their words where possible"),
      owners: list("'me' unless another person is clearly the one who owes it"),
      due_dates: list("As stated ('friday', 'next week'), or 'someday'"),
      priorities: {
        type: "array",
        items: enumField(["now", "soon", "someday"], "Urgency as stated, not as guessed"),
      },
      projects: list("A one-or-two-word bucket: work, home, health, money, admin"),
      minutes: {
        type: "array",
        items: { type: "integer", minimum: 1, maximum: 480 },
        description: "Rough guess at how long it takes",
      },
    },
    required: ["tasks", "owners", "due_dates", "priorities", "projects", "minutes"],
  },
  aligned: [["tasks", "owners", "due_dates", "priorities", "projects", "minutes"]],
  // `tasks` is the row count; everything else is a column that must match it.
  // The model reliably collapses repeated values ("me", "me", "me" becomes one),
  // so the columns need defaults rather than the rows needing truncation.
  spine: "tasks",
  fill: { owners: "me", due_dates: "someday", priorities: "someday", projects: "general", minutes: 15 },
  buildPrompt: (input) =>
    `Turn this into tasks. Every array must have exactly one entry per task, in the same order — ` +
    `repeat a value rather than shortening an array.\n\n${input}`,
};

export const NEXT_ACTION = {
  id: "next-action",
  temperature: 0.2,
  maxTokens: 320,
  system:
    "You pick the single next thing someone should do from their list. Pick the one that unblocks " +
    "the most, or the one whose deadline is closest, or the two-minute one that has been sitting " +
    "there for weeks - and say which of those reasons it is. Pick exactly one. Never answer 'it depends'.",
  schema: {
    type: "object",
    properties: {
      pick: { type: "integer", minimum: 1, description: "The number of the chosen task" },
      because: enumField(
        ["deadline_closest", "unblocks_others", "quick_win", "been_waiting_longest", "highest_stakes"],
        "The reason type"
      ),
      say_it: { type: "string", description: "One sentence, spoken to them, plainly" },
      skip_for_now: { type: "string", description: "One thing they can stop worrying about today" },
    },
    required: ["pick", "because", "say_it", "skip_for_now"],
  },
  buildPrompt: (input) => `${input}\n\nWhich single task should they do next?`,
};

/* ================================================================== *
 * Journal
 * ================================================================== */

export const JOURNAL_READ = {
  id: "journal-read",
  temperature: 0,
  maxTokens: 600,
  system:
    "You read a personal journal entry and pull out what is in it. You are not a therapist and you " +
    "do not give advice, diagnose, or reassure. Record only what the entry actually says. If someone " +
    "is named, list the name exactly as written. If the entry is flat and uneventful, say so - not " +
    "every day is a feeling.",
  schema: {
    type: "object",
    properties: {
      mood: enumField(
        ["good", "content", "flat", "tired", "anxious", "low", "frustrated", "excited"],
        "The dominant feeling in the entry"
      ),
      mood_score: score(5, "0 worst, 5 best - for charting over time"),
      energy: enumField(["drained", "low", "steady", "high"], "Physical energy described"),
      people: list("Names mentioned, exactly as written"),
      topics: list("Two to five short topic words"),
      worries: list("Things they said they are worried about. Empty if none."),
      commitments: list("Things they said they will do. Empty if none."),
      one_line: { type: "string", description: "The day in one sentence, in third person" },
    },
    required: ["mood", "mood_score", "energy", "people", "topics", "worries", "commitments", "one_line"],
  },
  buildPrompt: (input) => `Read this journal entry:\n\n${input}`,
};

export const JOURNAL_PATTERN = {
  id: "journal-pattern",
  temperature: 0.3,
  maxTokens: 420,
  system:
    "You look across several journal entries and name one pattern that is actually in them. " +
    "Quote the evidence. If the entries are too few or too varied to support a pattern, say so " +
    "with found=false rather than manufacturing one - a made-up insight about someone's own life " +
    "is worse than no insight.",
  schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "Is there genuinely a pattern here?" },
      pattern: { type: "string", description: "One sentence. Empty if found is false." },
      evidence: list("Short quotes or dates from the entries that support it"),
      trend: enumField(["improving", "steady", "declining", "too_early_to_say"], "Direction over time"),
      question: { type: "string", description: "One question worth sitting with. Not advice." },
    },
    required: ["found", "pattern", "evidence", "trend", "question"],
  },
  buildPrompt: (input) => `${input}\n\nIs there a real pattern across these entries?`,
};

/* ================================================================== *
 * The Pile
 * ================================================================== */

export const SHELF_READ = {
  id: "shelf-read",
  temperature: 0,
  maxTokens: 620,
  system:
    "You read an article and file it. The summary is for someone deciding whether to read it, so " +
    "lead with what it argues, not what it is about. Note the claims it actually makes - those are " +
    "what a later article might contradict. Estimate reading time from the length you were given.",
  schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Its title, or your best short name for it" },
      one_liner: { type: "string", description: "What it argues, in one sentence" },
      topics: list("Three to six short tags"),
      claims: list("The specific assertions it makes"),
      answers: { type: "string", description: "The question a reader would come here to answer" },
      minutes: { type: "integer", minimum: 1, maximum: 180, description: "Reading time" },
      difficulty: enumField(["easy", "medium", "heavy"], "Effort required"),
    },
    required: ["title", "one_liner", "topics", "claims", "answers", "minutes", "difficulty"],
  },
  buildPrompt: (input) => `File this article:\n\n${input}`,
};

export const LIBRARIAN = {
  id: "librarian",
  temperature: 0,
  maxTokens: 400,
  system:
    "You are a librarian matching a half-remembered description to a shelf of articles. The reader " +
    "will not use the words the article used - they remember what it was about, not what it said. " +
    "Match on meaning. If nothing on the shelf matches, say so with found=false; a confident wrong " +
    "answer wastes more of their time than an honest miss.",
  schema: {
    type: "object",
    properties: {
      found: { type: "boolean" },
      pick: { type: "integer", minimum: 0, description: "The number of the matching article, 0 if none" },
      runner_up: { type: "integer", minimum: 0, description: "Second best, 0 if none" },
      because: { type: "string", description: "One sentence on why this is the one" },
    },
    required: ["found", "pick", "runner_up", "because"],
  },
  buildPrompt: (input) => `${input}\n\nWhich one are they thinking of?`,
};

export const SHELF_PICK = {
  id: "shelf-pick",
  temperature: 0.2,
  maxTokens: 380,
  system:
    "You choose one article for someone who has a specific amount of time and a specific amount of " +
    "energy right now. Respect both. Do not hand a tired person a heavy article because it is " +
    "important - they will not read it, and the pile grows.",
  schema: {
    type: "object",
    properties: {
      pick: { type: "integer", minimum: 1, description: "The number of the chosen article" },
      because: { type: "string", description: "One sentence, spoken to them" },
      not_now: { type: "string", description: "One they should deliberately not read today, and why" },
    },
    required: ["pick", "because", "not_now"],
  },
  buildPrompt: (input) => `${input}\n\nPick exactly one to read now.`,
};

export const MIRROR = {
  id: "mirror",
  temperature: 0.3,
  maxTokens: 340,
  system:
    "You are handed statistics about what someone saves versus what they actually read. Say the " +
    "true and slightly uncomfortable thing, in one or two sentences, without being cruel and " +
    "without softening it into nothing. No advice. Just the observation.",
  schema: {
    type: "object",
    properties: {
      observation: { type: "string", description: "The uncomfortable true thing" },
      saves_but_avoids: { type: "string", description: "The topic they hoard and never read" },
      actually_reads: { type: "string", description: "The topic they genuinely engage with" },
    },
    required: ["observation", "saves_but_avoids", "actually_reads"],
  },
  buildPrompt: (input) => `${input}\n\nWhat does this say about them?`,
};

/* ================================================================== *
 * Recommend Me
 * ================================================================== */

export const TASTE = {
  id: "taste",
  temperature: 0.4,
  maxTokens: 420,
  system:
    "You turn a vague mood into catalogue search terms. You are NOT naming titles - you are " +
    "producing the SUBJECT words a librarian would search for.\n\n" +
    "Each query is one to three words naming a genre, subject or theme. Never a sentence. Never " +
    "'like X' or 'similar to X'. Never a word lifted out of their sentence - find the topic it is " +
    "about.\n\n" +
    "Examples:\n" +
    "  \"a book about how cities actually work\" -> urban planning, urbanism, city design\n" +
    "  \"something like Nope but funnier\" -> horror comedy, sci-fi comedy, alien invasion\n" +
    "  \"sad in a good way\" -> literary fiction, melancholy drama, grief\n" +
    "  \"a show to watch while cooking\" -> sitcom, light comedy, cooking show\n\n" +
    "If they name a medium - a book, a film, a show - put ONLY that medium in `wants`.",
  schema: {
    type: "object",
    properties: {
      wants: {
        type: "array",
        items: enumField(["film", "show", "book"], "Medium"),
        description: "Which mediums to search, based on what they asked for",
      },
      queries: list("Three to five short search phrases"),
      vibe: list("Two to four adjectives describing the mood they want"),
      avoid: list("Anything they said they do not want. Empty if nothing."),
    },
    required: ["wants", "queries", "vibe", "avoid"],
  },
  buildPrompt: (input) =>
    `Someone says: "${input}"\n\nWhat is this ABOUT? Give three to five subject or genre ` +
    `phrases of one to three words each, and only the mediums they actually asked for.`,
};

export const PICK = {
  id: "pick",
  temperature: 0.3,
  // Everything about this budget is set by throughput, not by quality. At the
  // ~15 tok/s a 1.5B model manages on an integrated GPU, a thousand tokens of
  // output is over a minute of staring at a spinner. Given an unbounded list
  // the model writes a paragraph about every candidate; told to pick four and
  // keep each to a line, the whole generation fits in a few hundred tokens.
  maxTokens: 560,
  system:
    "You choose from a numbered list of real titles and say why each suits the person.\n\n" +
    "Rules:\n" +
    "- Choose ONLY numbers that appear in the list.\n" +
    "- Choose AT MOST FOUR. Fewer is fine and better than padding.\n" +
    "- Each reason is ONE sentence, under twenty words, written to them.\n" +
    "- No plot summary - they can read the blurb. Say why THIS one, for THIS mood.\n" +
    "- If nothing on the list really fits, pick one or two and set good_match to false.",
  schema: {
    type: "object",
    properties: {
      picks: {
        type: "array",
        items: { type: "integer", minimum: 1 },
        maxItems: 4,
        description: "At most four numbers from the list, best first",
      },
      why: {
        type: "array",
        items: { type: "string" },
        maxItems: 4,
        description: "One short sentence per pick, in the same order",
      },
      good_match: { type: "boolean", description: "False if the catalogue did not really have it" },
    },
    required: ["picks", "why", "good_match"],
  },
  aligned: [["picks", "why"]],
  spine: "picks",
  fill: { why: "" },
  buildPrompt: (input) => `${input}\n\nPick the best few and say why each suits them.`,
};

/* ================================================================== *
 * registry
 * ================================================================== */

export const APP_AGENTS = {
  braindump: BRAINDUMP,
  "next-action": NEXT_ACTION,
  "journal-read": JOURNAL_READ,
  "journal-pattern": JOURNAL_PATTERN,
  "shelf-read": SHELF_READ,
  librarian: LIBRARIAN,
  "shelf-pick": SHELF_PICK,
  mirror: MIRROR,
  taste: TASTE,
  pick: PICK,
};
