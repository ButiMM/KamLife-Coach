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
const GENERIC_ASK_RE = /\bwhat do you need from me right now\??\b/i;
const HARD_TRAINING_RE = /\b(squat|deadlift|run|sprint|jump|plyometric|heavy)\b/i;

export function enforceCoachGuardrails(input: string, context: GuardrailContext): GuardrailResult {
  let reply = (input || "").trim();
  const violations: string[] = [];
  const budget = (context.budgetTier || "").toLowerCase();
  const injuries = (context.injuries || "").toLowerCase();

  if (GENERIC_ASK_RE.test(reply)) {
    violations.push("GENERIC_OPEN_QUESTION");
    reply = reply.replace(GENERIC_ASK_RE, "Tell me the one thing to fix first.");
  }

  const lowBudget = budget === "under_100" || budget === "under_50" || budget === "50_100";
  if (lowBudget && PREMIUM_FOOD_RE.test(reply)) {
    violations.push("BUDGET_MISMATCH");
    reply = `${reply.replace(PREMIUM_FOOD_RE, "eggs or pilchards")} For your budget, eggs, pilchards, and sugar beans are priority proteins.`;
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
