export type GuardrailContext = {
  userMessage: string;
  budgetTier?: string | null;
  injuries?: string | null;
};

export type GuardrailResult = {
  reply: string;
  violations: string[];
};

const PREMIUM_FOOD_RE = /\b(greek\s*yog(?:h)?urt|quinoa|salmon|avocado toast|woolworths)\b/i;
// Separate global-flagged copy for replace-all — keeping it distinct from PREMIUM_FOOD_RE
// avoids any .test()/.lastIndex statefulness footgun on the shared module-level regex.
const PREMIUM_FOOD_RE_ALL = /\b(greek\s*yog(?:h)?urt|quinoa|salmon|avocado toast|woolworths)\b/gi;
const GENERIC_ASK_RE = /\bwhat do you need from me right now\??\b/i;
const HARD_TRAINING_RE = /\b(squat|deadlift|run|sprint|jump|plyometric|heavy)\b/i;

// Phrases the coach prompt explicitly bans — GPT still produces them sometimes.
// Strip or replace them before the reply goes to the client.
const BANNED_PHRASES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bIt sounds like\b/gi, replacement: "" },
  { pattern: /\bIt seems like\b/gi, replacement: "" },
  { pattern: /\bI understand your frustration\.?\b/gi, replacement: "" },
  { pattern: /\bI understand that\b/gi, replacement: "" },
  { pattern: /\bHow can I help you(?: today)?\??\b/gi, replacement: "What do you need right now?" },
  { pattern: /\bAbsolutely[!,.]?\s*/gi, replacement: "" },
  { pattern: /\bCertainly[!,.]?\s*/gi, replacement: "" },
  { pattern: /\bGreat question[!.]?\s*/gi, replacement: "" },
  { pattern: /\bAmazing[!,.]?\s*/gi, replacement: "" },
  { pattern: /\bFantastic[!,.]?\s*/gi, replacement: "" },
  { pattern: /\bAwesome[!,.]?\s*/gi, replacement: "" },
  { pattern: /\bI hope this helps\.?\s*/gi, replacement: "" },
  { pattern: /\bFeel free to (ask|reach out)[^.]*\.?\s*/gi, replacement: "" },
  { pattern: /\bLet me know if you need anything\.?\s*/gi, replacement: "" },
  { pattern: /\bAs your coach,?\s*/gi, replacement: "" },
  { pattern: /\bYou'?ve got this\.?\s*/gi, replacement: "" },
  { pattern: /\bStay hydrated\.?\s*/gi, replacement: "" },
  { pattern: /\bBased on your data,?\s*/gi, replacement: "" },
  { pattern: /\bAccording to your logs,?\s*/gi, replacement: "" },
  { pattern: /\bI can see that\s*/gi, replacement: "" },
  { pattern: /\bI notice that\s*/gi, replacement: "" },
  // Therapist-speak observed leaking in production (2026-07-05 screenshots) —
  // sentence-level strips: the phrase drags the whole hollow sentence with it.
  { pattern: /\bIt'?s understandable[^.!?]*[.!?]\s*/gi, replacement: "" },
  { pattern: /\bWeight fluctuations are normal[^.!?]*[.!?]\s*/gi, replacement: "" },
  { pattern: /\btrust the process[.!]?\s*/gi, replacement: "" },
  { pattern: /\bkick-?start\b/gi, replacement: "start" },
  { pattern: /\bStay positive[.!]?\s*/gi, replacement: "" },
  { pattern: /\bI hear you[,.!]?\s*/gi, replacement: "" },
];

export function enforceCoachGuardrails(input: string, context: GuardrailContext): GuardrailResult {
  let reply = (input || "").trim();
  const violations: string[] = [];
  const budget = (context.budgetTier || "").toLowerCase();
  const injuries = (context.injuries || "").toLowerCase();

  // Strip banned phrases before anything else
  for (const { pattern, replacement } of BANNED_PHRASES) {
    if (pattern.test(reply)) {
      violations.push(`BANNED_PHRASE:${pattern.source.slice(0, 30)}`);
      reply = reply.replace(pattern, replacement);
    }
  }
  // Clean up double spaces and leading/trailing whitespace left by removals
  reply = reply.replace(/\s{2,}/g, " ").replace(/^\s+/, "").replace(/\.\s+\./g, ".").trim();

  if (GENERIC_ASK_RE.test(reply)) {
    violations.push("GENERIC_OPEN_QUESTION");
    reply = reply.replace(GENERIC_ASK_RE, "Tell me the one thing to fix first.");
  }

  const lowBudget = budget === "under_100" || budget === "under_50" || budget === "50_100";
  if (lowBudget && PREMIUM_FOOD_RE.test(reply)) {
    violations.push("BUDGET_MISMATCH");
    reply = `${reply.replace(PREMIUM_FOOD_RE_ALL, "eggs or pilchards")} For your budget, eggs, pilchards, and sugar beans are priority proteins.`;
  }

  const hasKnownInjury = injuries && injuries !== "none";
  if (hasKnownInjury && HARD_TRAINING_RE.test(reply) && !/\b(pain[- ]?free|avoid pain|no pain)\b/i.test(reply)) {
    violations.push("INJURY_CONTEXT_MISS");
    reply = `${reply} Keep it pain-free and avoid loading the injured area today.`;
  }

  if (!reply) {
    violations.push("EMPTY_REPLY");
    reply = "I had a glitch. Send your last message again and I will respond properly.";
  }

  return { reply, violations };
}

export function classifyMediaFailure(stage: string, rawError?: unknown): string {
  const msg = String(rawError || "").toLowerCase();
  if (msg.includes("timeout")) return `${stage.toUpperCase()}_TIMEOUT`;
  if (msg.includes("401") || msg.includes("403")) return `${stage.toUpperCase()}_AUTH`;
  if (msg.includes("codec") || msg.includes("mime") || msg.includes("format")) return `${stage.toUpperCase()}_FORMAT`;
  return `${stage.toUpperCase()}_FAIL`;
}
