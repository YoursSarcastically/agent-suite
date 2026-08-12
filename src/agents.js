/**
 * Twelve agents.
 *
 * Each is a declarative record, not a class: a system prompt, a JSON Schema the
 * decoder is constrained to, and a prompt builder. Adding a thirteenth means
 * adding an object to this array - there is no runtime to modify, which is the
 * point of pushing all the variability into the schema.
 *
 * A recurring constraint at 1.5B: enums beat free text. Every classification
 * field below is a closed set, because a small model asked for a "priority"
 * will happily invent "medium-high". Constrained decoding makes the enum a
 * hard guarantee rather than a hopeful instruction.
 */

const enumField = (values, description) => ({ type: "string", enum: values, description });

export const AGENTS = [
  {
    id: "triage",
    name: "Triage",
    blurb: "Sorts an inbound message into category, priority, and owning team.",
    icon: "\u{1F4E5}",
    system:
      "You triage inbound support messages. Classify precisely. If the message is ambiguous, " +
      "prefer the lower priority and say so in your reasoning rather than guessing high.",
    schema: {
      type: "object",
      properties: {
        category: enumField(
          ["billing", "bug", "feature_request", "how_to", "account", "outage", "spam", "other"],
          "Primary topic"
        ),
        priority: enumField(["low", "normal", "high", "urgent"], "Business impact"),
        team: enumField(["support", "engineering", "billing", "sales", "trust_safety"], "Owning team"),
        reasoning: { type: "string", description: "One sentence justifying the call" },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "0 to 1" },
      },
      required: ["category", "priority", "team", "reasoning", "confidence"],
    },
    buildPrompt: (input) => `Triage this message:\n\n${input}`,
    sample:
      "Subject: charged twice\n\nHi, I was billed $49 two times this month on the same card. " +
      "I need one of them refunded. This is the second time it's happened.",
  },

  {
    id: "extract",
    name: "Extract",
    blurb: "Pulls structured entities out of unstructured text.",
    icon: "\u{1F50D}",
    system:
      "You extract structured data from text. Use null for anything not explicitly present. " +
      "Never infer or invent a value that is not written down.",
    schema: {
      type: "object",
      properties: {
        order_ids: { type: "array", items: { type: "string" } },
        amounts: { type: "array", items: { type: "string" } },
        dates: { type: "array", items: { type: "string" } },
        emails: { type: "array", items: { type: "string" } },
        people: { type: "array", items: { type: "string" } },
        products: { type: "array", items: { type: "string" } },
      },
      required: ["order_ids", "amounts", "dates", "emails", "people", "products"],
    },
    buildPrompt: (input) => `Extract every entity present in:\n\n${input}`,
    sample:
      "Order #A-99271 placed on 3 March for the Aurora Desk Lamp came to $128.40. " +
      "Priya from accounts (priya@example.com) approved the refund on 11 March.",
  },

  {
    id: "summarize",
    name: "Summarize",
    blurb: "Turns a long thread into bullets, decisions, and open questions.",
    icon: "\u{1F4DD}",
    system:
      "You summarize conversation threads for someone who has not read them. " +
      "Be specific: name who owes what. Omit pleasantries entirely.",
    schema: {
      type: "object",
      properties: {
        one_liner: { type: "string", description: "The whole thread in one sentence" },
        key_points: { type: "array", items: { type: "string" } },
        decisions: { type: "array", items: { type: "string" } },
        open_questions: { type: "array", items: { type: "string" } },
      },
      required: ["one_liner", "key_points", "decisions", "open_questions"],
    },
    buildPrompt: (input) => `Summarize this thread:\n\n${input}`,
    sample:
      "Ana: The export job has been failing since Tuesday for accounts over 50k rows.\n" +
      "Ben: Confirmed, it's the 30s gateway timeout. We could paginate.\n" +
      "Ana: Do we ship the workaround or fix it properly?\n" +
      "Ben: Workaround this week, proper fix next sprint. I'll own the workaround.\n" +
      "Ana: Fine. Who tells the three affected customers?\n" +
      "Ben: Not sure yet.",
  },

  {
    id: "draft-reply",
    name: "Draft Reply",
    blurb: "Writes a grounded reply, and refuses when the context does not support one.",
    icon: "\u{270D}",
    system:
      "You draft support replies grounded strictly in the provided context. " +
      "If the context does not answer the question, set grounded=false and leave the body empty. " +
      "A refusal is a correct answer. Never fill a gap with a plausible guess.",
    schema: {
      type: "object",
      properties: {
        grounded: { type: "boolean", description: "Does the context actually support a reply?" },
        subject: { type: "string" },
        body: { type: "string" },
        missing_info: { type: "array", items: { type: "string" } },
      },
      required: ["grounded", "subject", "body", "missing_info"],
    },
    buildPrompt: (input) => `${input}\n\nDraft a reply grounded only in the context above.`,
    sample:
      "CONTEXT:\nRefunds are issued to the original payment method within 5-7 business days. " +
      "Duplicate charges are refunded in full with no restocking fee.\n\n" +
      "MESSAGE:\nI was charged twice for order #A-99271. How long until I get my money back?",
  },

  {
    id: "tone",
    name: "Tone Shift",
    blurb: "Rewrites text to a target tone without changing the facts.",
    icon: "\u{1F3AD}",
    system:
      "You rewrite text into a target tone. Preserve every factual claim, number, and commitment " +
      "exactly. Changing meaning is a failure, even if the rewrite reads better.",
    schema: {
      type: "object",
      properties: {
        rewritten: { type: "string" },
        changes_made: { type: "array", items: { type: "string" } },
        facts_preserved: { type: "boolean" },
      },
      required: ["rewritten", "changes_made", "facts_preserved"],
    },
    buildPrompt: (input) => `Rewrite to be warm, apologetic, and professional:\n\n${input}`,
    sample:
      "Your refund of $49 was processed. It takes 5-7 business days. " +
      "We can't speed it up. The duplicate charge was a system error on our end.",
  },

  {
    id: "sentiment",
    name: "Sentiment & Risk",
    blurb: "Reads emotional temperature and flags churn risk.",
    icon: "\u{1F321}",
    system:
      "You assess customer sentiment and escalation risk. Distinguish frustration with a product " +
      "from intent to leave - they are not the same signal and warrant different responses.",
    schema: {
      type: "object",
      properties: {
        sentiment: enumField(["positive", "neutral", "frustrated", "angry"], "Emotional tone"),
        churn_risk: enumField(["none", "low", "medium", "high"], "Likelihood of leaving"),
        escalate_to_human: { type: "boolean" },
        signals: { type: "array", items: { type: "string" }, description: "Phrases driving the call" },
      },
      required: ["sentiment", "churn_risk", "escalate_to_human", "signals"],
    },
    buildPrompt: (input) => `Assess sentiment and risk:\n\n${input}`,
    sample:
      "This is the third time I've written about this. Nobody has replied in six days. " +
      "I've already started moving my team to a competitor - just tell me how to export my data.",
  },

  {
    id: "route",
    name: "Intent Router",
    blurb: "Maps a message to a downstream workflow, or declines to guess.",
    icon: "\u{1F500}",
    system:
      "You route messages to workflows. If confidence is below 0.6, route to 'human_review'. " +
      "Routing wrongly is more expensive than routing to a human.",
    schema: {
      type: "object",
      properties: {
        workflow: enumField(
          ["issue_refund", "reset_password", "cancel_subscription", "track_order",
           "escalate_bug", "answer_from_kb", "human_review"],
          "Downstream workflow"
        ),
        confidence: { type: "number", minimum: 0, maximum: 1 },
        parameters: { type: "array", items: { type: "string" }, description: "Values the workflow needs" },
      },
      required: ["workflow", "confidence", "parameters"],
    },
    buildPrompt: (input) => `Route this message:\n\n${input}`,
    sample: "Can you cancel my plan? I don't want to be billed again next month. Account is dev@example.com.",
  },

  {
    id: "redact",
    name: "Redact",
    blurb: "Finds personal data and produces a safe-to-share version.",
    icon: "\u{1F510}",
    system:
      "You find personal and sensitive data and redact it. Replace each finding with a typed " +
      "placeholder such as [EMAIL] or [CARD]. When unsure whether something is personal, redact it.",
    schema: {
      type: "object",
      properties: {
        redacted_text: { type: "string" },
        // Parallel arrays rather than an array of {type, value} objects.
        // Nested object schemas hang the constrained decoder at this model size
        // (see README) - two flat arrays express the same thing and generate.
        finding_types: {
          type: "array",
          items: enumField(
            ["email", "phone", "name", "address", "card", "government_id", "credential", "other"],
            "Kind of data"
          ),
        },
        finding_values: { type: "array", items: { type: "string" } },
        safe_to_share: { type: "boolean" },
      },
      required: ["redacted_text", "finding_types", "finding_values", "safe_to_share"],
    },
    buildPrompt: (input) => `Redact all personal data:\n\n${input}`,
    sample:
      "Hi, it's Marcus Webb - reach me on +1 415 555 0142 or marcus.webb@example.com. " +
      "My card ending 4471 was charged at 22 Alder Road, Bristol.",
  },

  {
    id: "qa-score",
    name: "QA Scorer",
    blurb: "Grades a support reply against the customer's actual question.",
    icon: "\u{2696}",
    system:
      "You grade support replies. Score strictly. A reply that is polite but does not answer " +
      "the question scores low on resolution, however pleasant it reads.",
    schema: {
      type: "object",
      properties: {
        resolution: { type: "number", minimum: 0, maximum: 5, description: "0-5: does it actually answer?" },
        tone: { type: "number", minimum: 0, maximum: 5, description: "0-5" },
        accuracy: { type: "number", minimum: 0, maximum: 5, description: "0-5: supported by context?" },
        verdict: enumField(["send", "revise", "reject"], "What should happen to this draft"),
        critique: { type: "string" },
      },
      required: ["resolution", "tone", "accuracy", "verdict", "critique"],
    },
    buildPrompt: (input) => `Grade this exchange:\n\n${input}`,
    sample:
      "CUSTOMER: How long until my duplicate charge is refunded?\n\n" +
      "AGENT REPLY: Thank you so much for reaching out! We truly value your business and " +
      "apologize for any inconvenience. Our team is looking into this. Have a wonderful day!",
  },

  {
    id: "kb-gap",
    name: "Knowledge Gap",
    blurb: "Decides whether the knowledge base can answer at all.",
    icon: "\u{1F573}",
    system:
      "You decide whether the provided context genuinely answers the question. " +
      "Partial or tangential overlap is not an answer. Saying no is the expected outcome " +
      "most of the time, and is not a failure.",
    schema: {
      type: "object",
      properties: {
        answerable: { type: "boolean" },
        coverage: enumField(["none", "partial", "full"], "How well context covers the question"),
        gap: { type: "string", description: "What is missing, if anything" },
        suggested_article: { type: "string", description: "Title of the doc that should exist" },
      },
      required: ["answerable", "coverage", "gap", "suggested_article"],
    },
    buildPrompt: (input) => `${input}\n\nCan the context answer the question?`,
    sample:
      "CONTEXT:\nOur Pro plan costs $49/month and includes 10 seats. Billing is monthly.\n\n" +
      "QUESTION:\nDo you offer a discount for registered non-profits?",
  },

  {
    id: "translate",
    name: "Translate",
    blurb: "Translates while preserving register and any product terms.",
    icon: "\u{1F310}",
    system:
      "You translate text. Preserve the register of the original - a curt message stays curt. " +
      "Leave product names, order IDs, and codes untranslated.",
    schema: {
      type: "object",
      properties: {
        detected_language: { type: "string" },
        translation: { type: "string" },
        preserved_terms: { type: "array", items: { type: "string" } },
      },
      required: ["detected_language", "translation", "preserved_terms"],
    },
    buildPrompt: (input) => `Translate to English:\n\n${input}`,
    sample:
      "Bonjour, ma commande #A-99271 pour la lampe Aurora Desk n'est jamais arrivee. " +
      "Cela fait trois semaines. Je voudrais un remboursement complet.",
  },

  {
    id: "actions",
    name: "Action Items",
    blurb: "Extracts commitments with owners and deadlines.",
    icon: "\u{2705}",
    system:
      "You extract action items. Every item needs an owner. If no owner is stated, " +
      "set owner to 'unassigned' rather than guessing who probably meant to do it.",
    schema: {
      type: "object",
      properties: {
        // Flat parallel arrays, index-aligned - see the note on `redact`.
        tasks: { type: "array", items: { type: "string" } },
        owners: { type: "array", items: { type: "string" }, description: "'unassigned' if not stated" },
        due_dates: { type: "array", items: { type: "string" }, description: "As stated, or 'unspecified'" },
        unassigned_count: { type: "integer", minimum: 0 },
      },
      required: ["tasks", "owners", "due_dates", "unassigned_count"],
    },
    buildPrompt: (input) => `Extract action items:\n\n${input}`,
    sample:
      "Ben will ship the pagination workaround by Friday. The proper fix lands next sprint. " +
      "Someone needs to email the three affected customers before the workaround goes out - " +
      "that's blocking the release. Ana is on leave until Thursday.",
  },
];

export const byId = (id) => AGENTS.find((a) => a.id === id);
