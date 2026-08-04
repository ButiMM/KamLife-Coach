/**
 * THE ACTION INTERFACE — Phase 1 of the real inversion (2026-07-19).
 *
 * The whole architecture in one sentence: *the LLM does not touch the database — it
 * REQUESTS an action, and deterministic code validates and performs it.* This file is
 * that contract. Coach K stops being a talker behind ten keyword handlers and becomes
 * the decision-maker: it reads a message, decides what it MEANS, and emits ONE typed
 * CoachAction. The deterministic executor (next increment) performs it. Law 4 holds —
 * the model proposes, `validateAction` disposes.
 *
 * `validateAction` is the Tool Permission Gate: it takes raw, untrusted model output and
 * returns a SAFE action or falls back to JUST_REPLY. Every number is clamped to a sane
 * range; every enum is whitelisted; a malformed LOG_MEAL becomes JUST_REPLY rather than a
 * fabricated log. Nothing the model can emit can crash, corrupt, or over-write state.
 *
 * Pure and dependency-free so it is fully unit-testable and safe to import anywhere.
 * NOT yet wired to the live pipeline — wiring + replay proof is the next increment, and
 * it stays behind a flag until it beats the current system on replay for five days.
 */

// The meal slots the logger understands (mirrors utils.slotFromSastHour's output).
const MEAL_SLOTS = new Set(["breakfast", "lunch", "dinner", "snack", "night meal"]);

export type CoachAction =
  // Pure conversation — the default and the safe fallback. Coach K just talks.
  | { type: "JUST_REPLY" }
  // Record a meal the client reported. Coach K hands the FOOD TEXT ("2 eggs and pap")
  // and an optional slot — NOT the calories. The deterministic SA food scanner owns the
  // numbers (the LLM must never invent a kcal figure). needsConfirmation flips on when
  // Coach K is unsure (a vague amount) — the executor asks one question, not a silent log.
  | { type: "LOG_MEAL"; foodText: string; meal?: string; retro?: string; needsConfirmation: boolean }
  | { type: "REMOVE_LAST_MEAL" }
  | { type: "SHOW_MEALS" }
  | { type: "SHOW_WORKOUT" }
  | { type: "LOG_STEPS"; count: number }
  | { type: "LOG_WATER"; litres: number }
  | { type: "LOG_WEIGHT"; kg: number }
  | { type: "SET_SICK"; days: number }
  | { type: "END_SICK" }
  // The client asks to be reminded of something later ("remind me to take creatine at 8pm").
  // body = what to remind them; when = the natural-language time. The deterministic reminder
  // parser owns the actual clock maths, so the LLM never has to compute a fire time.
  | { type: "SET_REMINDER"; body: string; when: string };

export type CoachActionType = CoachAction["type"];

// The OpenAI tool schema Coach K emits against — the concrete interface. One tool per
// action; the model picks exactly one (or none → JUST_REPLY). Descriptions are the
// contract the model reads, so they carry the safety intent (confirm when unsure, never
// invent numbers, food logging is exact).
export const COACH_ACTION_TOOLS = [
  { type: "function", function: { name: "log_meal", description: "Record a meal the client REPORTED eating (past tense: 'I had', 'ate'). Pass food_text = the exact foods and amounts they named ('2 eggs and pap'); do NOT compute calories — the SA food database does that. Set needs_confirmation=true when the amount is vague ('some rice', 'a bit of'), so we ask instead of guessing. Do NOT call this for a question ('can I eat X?') or a plan ('I'll have X later').",
    parameters: { type: "object", required: ["food_text"], properties: {
      food_text: { type: "string", description: "the foods + amounts exactly as said, e.g. '2 eggs and pap'" },
      meal: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack", "night meal"] },
      retro: { type: "string", description: "a past day if they said one, e.g. 'yesterday'" },
      needs_confirmation: { type: "boolean" },
    } } } },
  { type: "function", function: { name: "remove_last_meal", description: "The client wants their most recent logged meal removed/undone.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "show_meals", description: "The client wants to SEE today's logged meals list.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "show_workout", description: "The client wants today's workout or their programme.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "log_steps", description: "The client REPORTED a step count for today.", parameters: { type: "object", required: ["count"], properties: { count: { type: "number" } } } } },
  { type: "function", function: { name: "log_water", description: "The client REPORTED drinking water (in litres).", parameters: { type: "object", required: ["litres"], properties: { litres: { type: "number" } } } } },
  { type: "function", function: { name: "log_weight", description: "The client REPORTED a body-weight reading (in kg).", parameters: { type: "object", required: ["kg"], properties: { kg: { type: "number" } } } } },
  { type: "function", function: { name: "set_sick", description: "The client says they are sick/unwell and cannot train. days = how long they'll rest (parse 'until Monday', '3 days'); default 3 if unstated.", parameters: { type: "object", required: ["days"], properties: { days: { type: "number" } } } } },
  { type: "function", function: { name: "end_sick", description: "The client says they are better/back and ready to resume.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "set_reminder", description: "The client asks to be reminded to do something at a later time ('remind me to take creatine at 8pm', 'nudge me about my meds tonight', 'remind me to weigh in Monday'). body = the task to remind them of; when = the time exactly as they said it ('at 8pm', 'tomorrow morning', 'in 2 hours', 'Monday'). Do NOT compute a clock time — the reminder system parses 'when'. Only for a real future reminder, never for a past log or a question.",
    parameters: { type: "object", required: ["body", "when"], properties: {
      body: { type: "string", description: "what to remind them to do, e.g. 'take creatine'" },
      when: { type: "string", description: "the time phrase exactly as said, e.g. 'at 8pm' or 'tomorrow morning'" },
    } } } },
] as const;

/**
 * THE ACTION DIRECTIVE — injected into Coach K's system prompt ONLY when action emission
 * is live. It exists because the constitution was written for the text-only world: Law 13
 * ("you have NO hands — tell them the WhatsApp command") and the THINK step ("otherwise you
 * talk") both actively steer AGAINST emitting a tool. That is exactly why the first replay
 * showed "i had a burger for lunch" → JUST_REPLY at an 18% miss rate. When the tools are on,
 * calling one IS the coach's hands — the deterministic executor does the write and sends the
 * confirmation — so this directive reconciles the conflict for transactions, and ONLY for
 * transactions. It stays example-driven off the real misses so the calibration is concrete.
 */
export const ACTION_DIRECTIVE = `🎯 YOU CAN ACT NOW — for CONCRETE TRANSACTIONS this overrides Constitution Law 13 ("no hands / tell them the command") and the THINK step's "otherwise you talk". You have real tools. Calling a tool IS your hands: the deterministic system does the numbers, writes the data, and sends the confirmation — so when you call a tool you do NOT also write prose and you do NOT tell them to type a command.

WHEN THE CLIENT REPORTS OR REQUESTS A CONCRETE TRANSACTION, CALL THE MATCHING TOOL (don't reply in words):
• food they ATE — "i had a burger for lunch", "2 eggs and pap" → log_meal
• "show me my workout", "what's today's session", "my programme" → show_workout
• "did 9000 steps" → log_steps · "drank 2 litres" → log_water
• body weight, however said — "I'm 82kg", "weighed in at 78.5kg", "82 on the scale this morning" → log_weight
• "remove my last meal" → remove_last_meal · "what did I eat today" → show_meals

CARE IS AN ACTION — do not let "care first" talk you out of the tool. Recording sick IS how you
hold their rest: set_sick pauses the programme, protects the streak, and stops the nudges. Your
warmth goes in the WORDS the system sends after; the tool does the holding.
• a fresh "I'm sick / can't train today / too sick / resting for 3 days / resting until Monday" → set_sick (MUST)
• "feeling better now / I'm back / ready to train again" → end_sick (MUST)

DO NOT call a tool — just talk — when it is NOT a fresh transaction:
• a QUESTION ("can I eat rice?", "how many steps should I do?")
• a PLAN / intention ("I'll have chicken later")
• FEELINGS or PROGRESS talk ("tell me about my progress", "I feel wrecked") → talk
• a REAFFIRMATION or memory grievance of something already true ("but I'm still sick", "why did you forget I'm sick") → acknowledge, do NOT re-write it

BUT a CORRECTION that CHANGES A STORED VALUE is a real write, not talk: "no, resting until MONDAY not Friday" changes the rest date → set_sick with the new day; "it was 2 eggs not 3" changes the log. Update the value with the tool.
One message = at most ONE tool: pick the single real transaction. In genuine doubt, talk.`;

/**
 * MEMORY-GRIEVANCE GUARD — a deterministic net under the LLM's judgement, not a prompt hope.
 * When a client complains that the coach FORGOT or ignored something already told ("I said
 * I'm still sick until Monday, why did you forget?"), that is a complaint about the coach's
 * memory — never a fresh instruction to write. The engine occasionally reads the "still sick
 * until Monday" in it as a fresh SET_SICK (the 2026-07-18 false-write). This catches that
 * class in code: a grievance can never fire a fresh sick write. Narrow on purpose — it keys
 * on the forgot/already-told language, so a real declaration ("I'm sick") or a value
 * correction ("resting until Monday, not Friday") is untouched.
 */
export function isMemoryGrievance(message: string): boolean {
  const m = (message || "").toLowerCase();
  return /\b(why (did|do|didn'?t) you (forget|remember|listen)|you (forgot|didn'?t (listen|remember))|already (said|told you)|told you (already|before)|like i (said|told)|i keep (telling|saying)|keep telling you)\b/.test(m);
}

/**
 * SICK-REAFFIRMATION GUARD — the other half of the same class. A bare continuation of an
 * ALREADY-KNOWN sick state ("but I'm still sick") is affirming what's true, not a fresh
 * instruction to write — re-firing SET_SICK just re-dumps the rest template. Caught in code
 * so the dangerous write goes to structural zero regardless of the model's temperature
 * variance. Deliberately NOT caught: a NEW duration ("still sick until Monday", "still sick,
 * 3 more days") IS a real update, and a fresh declaration ("I'm sick") has no "still" at all.
 */
export function isSickReaffirmation(message: string): boolean {
  const m = (message || "").toLowerCase();
  if (!/\bstill\b/.test(m)) return false;
  if (!/\b(sick|ill|unwell|not\s+(well|better|ok(ay)?)|resting|recover(ing)?|in\s+bed)\b/.test(m)) return false;
  const hasNewDuration = /\d+[^.!?]{0,10}\b(day|week)|\buntil\s+\w+|\btill\s+\w+|\bfor\s+(a|another|the)\b|\b(another|a\s+few|couple)\b[^.!?]{0,10}\b(day|week)/.test(m);
  return !hasNewDuration;
}

/**
 * CODE-LEVEL INTENT BOUNCER (external review Q1, 2026-07-21) — the mathematically-reliable
 * kill for tool over-firing. When a turn is STRATEGY or EMOTIONAL, the engine hands the model
 * NO action tools, so it physically cannot fire a workout dump / log / schedule on "let's talk
 * about running", "map my journey", "I want to give up", "I'm feeling down". Prompt rules alone
 * fail because the tool schema is salient in-context; removing the tool is absolute.
 *
 * Deliberately NARROW — a real data write must NEVER be stripped: any clear log/report signal
 * (ate/had, a meal label, a number with steps/kg/km/reps) keeps the tools, even inside an
 * emotional message ("rough day, only ate a slice of bread" still logs the bread).
 */
export function isStrategyOrEmotional(message: string): boolean {
  const s = (message || "").toLowerCase().trim();
  if (!s) return false;
  // Guardrail: a log/report keeps its action ability — never strip a data write.
  if (/\b(i (ate|had)|just (ate|had)|having|for (breakfast|lunch|dinner|supper)|logged)\b/.test(s)
    || /\b\d+\s*(steps|kg|kgs|km|l\b|litres?|ml|glasses?|reps|sets|min(ute)?s)\b/.test(s)) return false;
  const strategy = /\b(let'?s talk|talk(ing)? about|thoughts?\b|what do you (think|reckon)|how (do|can|should|would) i\b[^.!?]{0,40}\b(balance|incorporate|combine|approach|go about|fit|add|start|mix)|map (out )?my (journey|plan)|my (fitness )?journey|long.?term|where (am i|are we) (going|headed)|what'?s the point|giv(e|ing) up|why bother|i'?m done with|can'?t do this anymore)\b/.test(s);
  const emotional = /\b(i'?m (feeling |so |really |just |a bit |very )*(sad|down|depressed|low|demotivat\w*|unmotivat\w*|frustrat\w*|overwhelm\w*|stress\w*|anxious|lost|hopeless|defeated|burnt out|burned out)|i feel like (giving|quitting|nothing)|feeling (really |so |very )*(down|low|sad|lost|defeated)|feeling like giving up|motivate me|encourage me|i'?ve been thinking|struggling (mentally|emotionally)|mentally (drained|exhausted|tired))\b/.test(s);
  return strategy || emotional;
}

function clampNum(v: unknown, lo: number, hi: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : NaN;
}

/**
 * THE TOOL PERMISSION GATE (Law 4). Untrusted model output → a safe CoachAction, or
 * JUST_REPLY on anything malformed. Accepts either the OpenAI tool-call name form
 * ({ name, args }) or a plain { type, ... } object, so it validates whatever shape the
 * caller hands it. Never throws, never trusts a raw number, never fabricates a log.
 */
export function validateAction(raw: any): CoachAction {
  if (!raw || typeof raw !== "object") return { type: "JUST_REPLY" };
  // Normalise the tool-call name form to a type tag.
  const NAME_TO_TYPE: Record<string, CoachActionType> = {
    log_meal: "LOG_MEAL", remove_last_meal: "REMOVE_LAST_MEAL", show_meals: "SHOW_MEALS",
    show_workout: "SHOW_WORKOUT", log_steps: "LOG_STEPS", log_water: "LOG_WATER",
    log_weight: "LOG_WEIGHT", set_sick: "SET_SICK", end_sick: "END_SICK",
    set_reminder: "SET_REMINDER",
  };
  const a = raw.args && typeof raw.args === "object" ? raw.args : raw;
  const type: string = raw.type || NAME_TO_TYPE[String(raw.name || "").toLowerCase()] || "";

  switch (type) {
    case "REMOVE_LAST_MEAL": return { type: "REMOVE_LAST_MEAL" };
    case "SHOW_MEALS": return { type: "SHOW_MEALS" };
    case "SHOW_WORKOUT": return { type: "SHOW_WORKOUT" };
    case "END_SICK": return { type: "END_SICK" };
    case "LOG_STEPS": {
      const count = clampNum(a.count, 1, 100_000);
      return Number.isFinite(count) ? { type: "LOG_STEPS", count: Math.round(count) } : { type: "JUST_REPLY" };
    }
    case "LOG_WATER": {
      const litres = clampNum(a.litres, 0.1, 15);
      return Number.isFinite(litres) ? { type: "LOG_WATER", litres: Math.round(litres * 10) / 10 } : { type: "JUST_REPLY" };
    }
    case "LOG_WEIGHT": {
      // Weight feeds the trend/auto-adjust engine, so an out-of-range value is a MISPARSE
      // to reject, not to clamp — logging a false 25kg is worse than logging nothing.
      const kg = Number(a.kg);
      return Number.isFinite(kg) && kg >= 25 && kg <= 400 ? { type: "LOG_WEIGHT", kg: Math.round(kg * 10) / 10 } : { type: "JUST_REPLY" };
    }
    case "SET_SICK": {
      const days = clampNum(a.days ?? a.sickDays, 1, 14);
      return Number.isFinite(days) ? { type: "SET_SICK", days: Math.round(days) } : { type: "JUST_REPLY" };
    }
    case "SET_REMINDER": {
      const body = String(a.body ?? a.what ?? a.task ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
      const when = String(a.when ?? a.time ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (body.length < 2) return { type: "JUST_REPLY" };
      return { type: "SET_REMINDER", body, when };
    }
    case "LOG_MEAL": {
      // The LLM hands the FOOD TEXT; the deterministic scanner resolves foods + numbers.
      // Empty text → never fabricate a log; just talk.
      const foodText = String(a.food_text ?? a.foodText ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
      if (foodText.length < 2) return { type: "JUST_REPLY" };
      const mealRaw = String(a.meal || "").toLowerCase().trim();
      const meal = MEAL_SLOTS.has(mealRaw) ? mealRaw : undefined;
      const retro = typeof a.retro === "string" && a.retro.trim() ? a.retro.trim().slice(0, 20) : undefined;
      return { type: "LOG_MEAL", foodText, meal, retro, needsConfirmation: !!(a.needs_confirmation ?? a.needsConfirmation) };
    }
    default:
      return { type: "JUST_REPLY" };
  }
}

// ── EXECUTOR PRECONDITIONS (2026-07-19) — every reviewer converged here, and both map
// to a founder launch-blocker: the CONFIDENCE gate (unsafe behaviour) and IDEMPOTENCY
// (duplicated logs). They live on the contract so the executor increment is a thin, safe
// consumer — it never decides whether to run, only how.

// Coach K attaches a 0..1 confidence to each action. Below this, a STATE-WRITING action
// is not auto-executed — it's confirmed first ("~2 eggs? reply yes"). Read-only actions
// (SHOW_*, JUST_REPLY) ignore it — there's nothing to corrupt.
export const CONFIDENCE_TO_EXECUTE = 0.75;

const WRITES_STATE = new Set<CoachActionType>([
  "LOG_MEAL", "LOG_STEPS", "LOG_WATER", "LOG_WEIGHT", "REMOVE_LAST_MEAL", "SET_SICK", "END_SICK",
  "SET_REMINDER", // creates a row; idempotency stops a retry from double-scheduling the ping
]);

/** True if performing this action changes stored state (a wrong auto-run would corrupt). */
export function writesState(type: CoachActionType): boolean {
  return WRITES_STATE.has(type);
}

/**
 * Should this action auto-execute, or be confirmed first? A read-only action always runs.
 * A state-writing action runs only when confidence clears the bar AND the model didn't
 * already flag it (LOG_MEAL.needsConfirmation). This is the whole "infer, don't
 * interrogate — but confirm when unsure" posture, as one deterministic gate.
 */
export function shouldAutoExecute(action: CoachAction, confidence: number): boolean {
  if (!writesState(action.type)) return true;
  if (action.type === "LOG_MEAL" && action.needsConfirmation) return false;
  return Number.isFinite(confidence) && confidence >= CONFIDENCE_TO_EXECUTE;
}

/**
 * IDEMPOTENCY fingerprint — a deterministic key so a retry (WhatsApp redelivery, a
 * replay run, a network re-send) never double-writes. Keyed on the SOURCE MESSAGE id,
 * not the content: a literal retry of the same message collapses to one execution, while
 * two genuinely-separate "2 eggs" messages (different ids) both log honestly. The executor
 * skips a fingerprint it has already performed.
 */
/**
 * THE NUMBER BRAKE (2026-08-04, live, in the founder's own chat).
 *
 * He sent a voice note: "Yesterday I did have a session. I did the session for yesterday.
 * Can you just mark it." The coach replied "6,000 steps — you smashed the 6,000 target."
 * He then typed "talk to me" and got the SAME message, word for word, again.
 *
 * It was not a conversation failing twice. It was the engine emitting LOG_STEPS(6000) twice —
 * a deterministic executor reply, which is why it was byte-identical. And 6,000 was not a
 * number he had said. It was the number in the coach's OWN morning message, sitting in the
 * snapshot, which the model dutifully packed into the schema it had been handed.
 *
 * A model asked to fill `count: number` will fill it. So a numeric write action is only
 * allowed to carry a number the CLIENT actually typed or said. The digits must be present in
 * their message; if they are not, the action is not theirs and must not touch their data.
 *
 * The same rule already guards bulk intake. It was never applied to the actions that write.
 * This is the one that matters more: an invented intake field gets corrected in the next
 * message; an invented step log silently becomes their history.
 */
/**
 * GUARD #8 — THE AUTHORSHIP CONSTRAINT (2026-08-04).
 *
 * The inversion moved the engine to the front of the queue. It did NOT move authorship:
 * the brain read the room and then a template answered the door. That is why one product
 * has 29 voices and none of them are the founder's.
 *
 * The rule is "tools shut up, the engine writes every sentence" — and a rule enforced by a
 * keyword grep is a rule you can walk past. So it is enforced by the type system instead.
 * A tool returns ToolFacts: numbers, booleans, short identifiers. There is NOWHERE in this
 * type to put a sentence. Silence is not a convention a future edit can forget; it is a
 * compile error.
 *
 * Facts are what the coach is allowed to KNOW as a result of acting. The sentence built
 * from them is the engine's job, and the provenance gate still checks every figure in it
 * traces to a stored row.
 */
export type ToolFactValue = number | boolean | null;
export type ToolFacts = Record<string, ToolFactValue>;

export interface ToolOutcome {
  /** Did the write actually happen? */
  performed: boolean;
  /** What the coach now knows. Data only — the type admits no prose. */
  facts: ToolFacts;
}

export function actionNumberIsClientReported(action: CoachAction, clientMessage: string): boolean {
  const n = action.type === "LOG_STEPS" ? action.count
    : action.type === "LOG_WATER" ? action.litres
    : action.type === "LOG_WEIGHT" ? action.kg
    : null;
  if (n === null) return true;                       // not a numeric write — nothing to check
  const src = (clientMessage || "").toLowerCase();
  // Digit-boundary, not word-boundary: "90kg" and "6000steps" have no word boundary before
  // the unit, and rejecting those would break the logs this product exists to take.
  const present = (v: number) => new RegExp(`(?<!\\d)${v}(?!\\d)`).test(src);
  if (present(Math.round(n))) return true;
  // Spoken and shorthand forms of the same number: "6k", "6 thousand", "1.5 litres" → 1.5,
  // "six thousand" is handled upstream by digitizeSpokenAmounts before this ever runs.
  if (Number.isInteger(n) && n % 1000 === 0 && present(n / 1000)) return true;   // 6000 ← "6k"
  if (!Number.isInteger(n) && present(Math.round(n * 10) / 10)) return true;
  return false;
}

export function actionFingerprint(action: CoachAction, userId: string, sourceMessageId: string): string {
  return `${userId}:${sourceMessageId}:${action.type}`;
}

/** One-line human summary of an action — for the audit/replay log the inversion needs. */
export function describeAction(action: CoachAction): string {
  switch (action.type) {
    case "JUST_REPLY": return "reply only (no action)";
    case "LOG_MEAL": return `log "${action.foodText}"${action.meal ? ` as ${action.meal}` : ""}${action.retro ? ` (${action.retro})` : ""}${action.needsConfirmation ? " — confirm first" : ""}`;
    case "REMOVE_LAST_MEAL": return "remove last meal";
    case "SHOW_MEALS": return "show today's meals";
    case "SHOW_WORKOUT": return "show workout / programme";
    case "LOG_STEPS": return `log ${action.count} steps`;
    case "LOG_WATER": return `log ${action.litres}L water`;
    case "LOG_WEIGHT": return `log ${action.kg}kg`;
    case "SET_SICK": return `set sick for ${action.days} day(s)`;
    case "END_SICK": return "end sick / resume";
    case "SET_REMINDER": return `remind to "${action.body}"${action.when ? ` (${action.when})` : ""}`;
  }
}
