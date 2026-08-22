/**
 * REPLY VERIFIER — the self-correcting loop on the brain's mouth.
 *
 * Deterministic, zero-cost checks on every freeform Coach K reply. The verifier owns the
 * policy surface so the engine can self-correct once and fail open rather than sending a
 * reply already known to be wrong.
 */

import { parseMessyIntake } from "../understanding/messy-intake";
import { currentRuntimeDecision, forceRuntimeReferral, type RuntimeDecisionResult } from "../understanding/state";
import { detectMedicationContext } from "../medication-context";
// The canonical "is this a question" owner. utils.ts imports only ./sast, so this module stays
// free of the database and the model.
import { looksLikeQuestion, sessionCountsIn } from "../utils";

export interface VerifierFacts {
  goalType?: string | null;
  clientMessage?: string | null;
  /**
   * WHAT WE ACTUALLY HOLD FOR THIS CLIENT, RIGHT NOW (2026-08-20, response-graph audit).
   *
   * The step-attribution rule inferred provenance from LANGUAGE: it asked whether the client's
   * wording contained a steps term, and rejected the number if not. So "today's progress" —
   * answered correctly from the day ledger, including the 3,000 steps the client had logged four
   * hours earlier — was destroyed, and the client was told to describe what happened in his own
   * words. The most basic question in the product, answered by asking the customer.
   *
   * A claim is legitimate when it maps to a value we hold for this client and context:
   *
   *     claim → source → value → context
   *
   * This carries the value and the context. It is DELIBERATELY NOT "the handler touched the
   * ledger, trust everything" — that is the same shortcut with a new name. "3,000 steps today"
   * validates against `stepsToday`; "3,000 steps before lunch" does not, because we hold a daily
   * total and no intraday breakdown, and the context does not match.
   *
   * Absent, every existing rule behaves exactly as before — the model path passes nothing, so
   * nothing is loosened for freeform replies.
   */
  evidence?: {
    /** Today's step total from the day ledger, when the caller read it this turn. */
    stepsToday?: number | null;
    /**
     * Training sessions in `sessionsWindowDays`, counted from workoutLogs, when the caller read
     * them this turn. The same contract as `stepsToday` and for the same failure: on 21 August the
     * client wrote "I did all four workouts this week", the coach replied "all four workouts done
     * this week", and workoutLogs held ONE. The count is authoritative state; a model claim about
     * it is checkable against it.
     */
    sessionsWindow?: number | null;
    /** The window that count covers. Without it the number has no context to be checked in. */
    sessionsWindowDays?: number | null;
    /** The coaching decision this turn actually made, from chooseAction. */
    canonicalKind?: string | null;
    canonicalTodo?: string | null;
    /**
     * THE WHOLE REPLY for a decision turn, rendered deterministically from chooseAction. On a
     * decision turn this REPLACES the model's prose — the model is not the author of a turn that
     * carries an instruction.
     */
    canonicalReply?: string | null;
    /** True when the reply came off a model path — the one chokepoint tag() marks. */
    modelAuthored?: boolean;
    /** The CoachAction the engine emitted this turn, when it emitted one. Structured
     *  provenance — checked BEFORE the prose backstop. */
    structuredAction?: string | null;
    /** A clarification or de-escalation turn: strip directives, append no coaching instruction. */
    conversationalOnly?: boolean;
  };
}

export interface VerifierResult {
  ok: boolean;
  violation?: string;
}

const DECISION_VIOLATIONS = {
  empty: "empty reply",
  investigateMissing: "INVESTIGATE reply must explicitly acknowledge insufficient evidence and identify the minimum evidence needed",
  investigateChange: "INVESTIGATE reply must not prescribe a plan-level change before evidence is sufficient",
  continueChange: "CONTINUE reply must not invent a plan-level change when the deterministic decision is no-change",
  referMissing: "REFER reply must clearly direct the client to appropriate professional/medical support",
};

function lowerWords(text: string): string[] {
  return text.toLowerCase().split(" ").map(word => word
    .replaceAll(",", "")
    .replaceAll(".", "")
    .replaceAll(":", "")
    .replaceAll(";", "")
    .replaceAll("!", "")
    .replaceAll("?", "")
    .replaceAll("(", "")
    .replaceAll(")", "")
    .replaceAll("\"", "")
    .replaceAll("'", "")
    .trim()
  ).filter(Boolean);
}

function containsAny(text: string, phrases: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some(phrase => lower.includes(phrase));
}

function containsPlanChange(text: string): boolean {
  const words = lowerWords(text);
  const change = ["lower", "raise", "increase", "decrease", "cut", "add", "remove", "change", "adjust", "drop", "bump"];
  const plan = ["calorie", "calories", "kcal", "protein", "steps", "step", "target", "intake", "deficit", "plan"];
  return change.some(word => words.includes(word)) && plan.some(word => words.includes(word));
}

function decisionBoundaryViolation(reply: string, decision: RuntimeDecisionResult): string | null {
  const text = (reply || "").trim();
  if (!text) return DECISION_VIOLATIONS.empty;

  if (decision.state === "INVESTIGATE") {
    if (!containsAny(text, [
      "i don't know yet", "i do not know yet", "not enough data", "not enough logged", "not enough evidence",
      "need another day", "need more days", "need more data", "need more evidence", "log another day", "log a few more", "i need to see more",
    ])) return DECISION_VIOLATIONS.investigateMissing;
    if (containsPlanChange(text)) return DECISION_VIOLATIONS.investigateChange;
  }

  if (decision.state === "CONTINUE" && containsPlanChange(text)) return DECISION_VIOLATIONS.continueChange;

  if (decision.state === "REFER" && !containsAny(text, [
    "doctor", "dietitian", "clinician", "healthcare professional", "medical help", "seek medical care", "emergency",
  ])) return DECISION_VIOLATIONS.referMissing;

  return null;
}

function medicationBoundaryViolation(reply: string, clientMessage: string): string | null {
  const medication = detectMedicationContext(clientMessage);
  if (!medication.unsafeRequest) return null;
  const text = (reply || "").toLowerCase();
  if (!containsAny(text, ["doctor", "pharmacist", "clinician", "healthcare professional", "medical care", "seek medical help", "emergency"])) {
    return `Unsafe medication request (${medication.reason}) must be redirected to a doctor, pharmacist, or other appropriate medical professional; do not answer it as ordinary coaching.`;
  }
  if (/\b(calorie|calories|kcal|protein|steps|step|workout|training|session|deficit|meal plan|diet)\b/i.test(text)) {
    return `Unsafe medication request (${medication.reason}) must remain a referral/safety response. Do not continue ordinary diet, training, or weight-loss coaching in the same reply.`;
  }
  if (medication.reason === "sourcing" && /\b(buy|seller|supplier|source|sourcing|black market|hairdresser)\b/i.test(text)) {
    return "The reply must not facilitate medication sourcing or black-market access.";
  }
  return null;
}

function normaliseStepToken(word: string): string {
  return word
    .replaceAll(",", "")
    .replaceAll(".", "")
    .replaceAll(":", "")
    .replaceAll(";", "")
    .replaceAll("!", "")
    .replaceAll("?", "")
    .replaceAll("(", "")
    .replaceAll(")", "")
    .replaceAll("\"", "")
    .replaceAll("'", "")
    .trim();
}

function stepWords(text: string): string[] {
  return (text || "").toLowerCase().split(" ").map(normaliseStepToken).filter(Boolean);
}

function isStepWord(word: string): boolean {
  return word === "step" || word === "steps" || word === "walk" || word === "walked" || word === "walking";
}

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

/** "three thousand" / "fifteen hundred" → number. Fail-open on unknown phrasing. */
function parseWordNumberPhrase(words: string[], start: number): { value: number; consumed: number } | null {
  let i = start;
  let total = 0;
  let current = 0;
  let consumed = 0;
  while (i < words.length) {
    const w = words[i];
    const n = WORD_NUMBERS[w];
    if (n === undefined) break;
    if (n === 1000) {
      current = (current || 1) * 1000;
      total += current;
      current = 0;
    } else if (n === 100) {
      current = (current || 1) * 100;
    } else {
      current += n;
    }
    consumed += 1;
    i += 1;
  }
  const value = total + current;
  if (consumed === 0 || !Number.isFinite(value) || value <= 0) return null;
  return { value, consumed };
}

function extractStepNumbers(text: string): number[] {
  const words = stepWords(text);
  const out: number[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (isStepWord(word)) {
      const nextNum = Number(words[i + 1]?.replaceAll(",", ""));
      if (Number.isFinite(nextNum)) out.push(nextNum);
      const phraseBefore = parseWordNumberPhrase(words, Math.max(0, i - 4));
      // Prefer phrase immediately preceding the step word
      for (let back = 1; back <= 4 && i - back >= 0; back += 1) {
        const p = parseWordNumberPhrase(words, i - back);
        if (p && p.consumed === back) {
          out.push(p.value);
          break;
        }
      }
      continue;
    }
    const number = Number(word.replaceAll(",", ""));
    if (Number.isFinite(number) && isStepWord(words[i + 1] || "")) out.push(number);
    // "three thousand steps"
    if (WORD_NUMBERS[word] !== undefined && isStepWord(words[i + 1] || "") === false) {
      const p = parseWordNumberPhrase(words, i);
      if (p) {
        const after = words[i + p.consumed];
        if (isStepWord(after || "")) out.push(p.value);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * NOT A PHRASE LIST ANY MORE (2026-08-20, phone P0).
 *
 * This was seven literal strings. The founder asked "How does my daily step count affect my
 * progress and calorie burn and energy levels" — a question this rule's own violation text says
 * we MAY answer from state — and "my daily step count" was in none of them. The reply was
 * blocked, and the client got "Let me not guess on that one. Tell me what happened in your own
 * words", which asks somebody to narrate an event when they asked a question.
 *
 * A list of phrasings can only ever be as good as the phrasings somebody thought of. This is the
 * shape instead, and the "is this a question" half is looksLikeQuestion — the canonical owner,
 * which already knows that "did 9000 steps" is a REPORT and not an interrogative.
 */
function isExplicitStepQuery(text: string): boolean {
  const q = (text || "").toLowerCase();
  if (!/\b(steps?|step count|walking|walked)\b/.test(q)) return false;
  return looksLikeQuestion(text) || /\bmy\b[^.?!]{0,24}\b(steps?|step count)\b/.test(q);
}

/**
 * A TARGET IS NOT AN ATTRIBUTION (2026-08-19).
 *
 * This rule exists to stop the coach telling a client they walked a number they never reported.
 * It read every step figure in a reply as such a claim — including "8,000 steps/day", which is a
 * PRESCRIPTION about tomorrow, not a statement about yesterday.
 *
 * Cost of the confusion, once Cut 3 made the verdict binding: completeOnboarding() prints the
 * client's targets, so the FIRST MESSAGE A NEW CLIENT EVER RECEIVES — their programme, their
 * numbers, how the coach works — was replaced with "Let me not guess on that one." Every new
 * signup. Found by onboarding-e2e, which had been red on main and was sitting fourteenth in an
 * `&&` chain, so the eight guards behind it stopped running too.
 *
 * Deliberately narrow. Only the unambiguous per-day and named-target forms are redacted before
 * the attribution check; "you did 8,000 steps" and "you hit 8,000 steps today" are untouched and
 * must still fail. Redaction, not an exemption — a reply that ALSO makes a real attribution still
 * gets caught on that clause.
 */
/**
 * A segment is prescriptive when it frames the number as something to reach.
 *
 * The per-WEEK forms were added 2026-08-22 when the training count came under the same rule.
 * "Three sessions a week" and "aim for four workouts" are the programme, not a claim about what
 * happened — and the CLIENT_DID_IT guard below is what stops that becoming a hole, because
 * "you've done three sessions this week" says a target word and is still an attribution.
 */
const TARGET_MARKER = /\btargets?\b|\bgoals?\b|\baim\s+for\b|\/\s*day\b|\bper\s+day\b|\ba\s+day\b|\bnon-negotiable\b|\/\s*week\b|\bper\s+week\b|\ba\s+week\b|\bweekly\b/i;

/**
 * …and it stops being prescriptive the moment it also says the CLIENT DID IT. "You did 6,000
 * steps against a target of 8,000" names a target and is still an attribution, so it stays
 * subject to the rule. Deliberately generous: a false hit here only restores the strict old
 * behaviour, which is the safe direction to fail in.
 */
const CLIENT_DID_IT = /\b(?:you(?:'ve| have| are|'re)?\s+(?:already\s+)?(?:walked|did|done|hit|got|clocked|logged|managed|racked|at|trained|completed|finished|smashed)|walked|clocked|trained|racked\s+up|\bthat'?s\s+\w+\s+(?:workouts?|sessions?)\b)\b/i;

/**
 * Blank out prescriptive segments before the attribution check. Split per line AND per sentence,
 * so one bullet in a target list cannot borrow an attribution verb from another line.
 */
function withoutTargetSegments(reply: string): string {
  return (reply || "")
    .split(/(\n+|(?<=[.!?])\s+)/)
    .map(seg => (TARGET_MARKER.test(seg) && !CLIENT_DID_IT.test(seg) ? " " : seg))
    .join("");
}

/**
 * DOES THIS CLAIM NAME A WINDOW WE MEASURED? One question, one owner (merged 2026-08-22).
 *
 * Steps are held as a DAILY total, sessions as a rolling multi-day count, and the failure is
 * identical in both directions: a claim attached to a span we never counted is unevidenced even
 * when the digits are right. "3,000 steps before lunch" is not a day; "four sessions since you
 * started" is not the last seven days. Splitting this into a narrower-than and a wider-than
 * matcher gave each rule half a guard — the step rule could not see "this month" and the session
 * rule could not see "this morning" — so it is one list of the windows we do not hold.
 */
const OUT_OF_WINDOW = /\b(?:before|after|by)\s+(?:lunch|breakfast|dinner|noon|midday|\d{1,2}\s?(?:am|pm))\b|\bthis (?:morning|afternoon|evening)\b|\bin the (?:morning|afternoon|evening)\b|\bper hour\b|\bsince (?:lunch|breakfast|this morning)\b|\b(?:this|last|the past|next)\s+month\b|\bin total\b|\ball[\s-]?time\b|\bsince you (?:started|began|joined)\b|\bthis year\b|\baltogether\b/i;

function verifyStepAttribution(reply: string, clientMessage: string, evidence?: VerifierFacts["evidence"]): VerifierResult {
  const replySteps = extractStepNumbers(withoutTargetSegments(reply));
  if (replySteps.length === 0) return { ok: true };
  // PROVENANCE BEFORE PHRASING. A number we hold for this client today is a recital, not an
  // attribution — regardless of how they happened to word the question. The context guard is the
  // half that keeps this honest: we hold a DAILY total, so a claim about part of a day is still
  // unevidenced even though the digits match.
  const held = evidence?.stepsToday;
  if (typeof held === "number" && held > 0 && replySteps.every(n => n === held) && !OUT_OF_WINDOW.test(reply)) {
    return { ok: true };
  }
  // REMOVED 2026-08-21: `if (isExplicitStepQuery(clientMessage)) return { ok: true }`.
  //
  // That was the last rule in this file where a claim's VALIDITY depended on how the client
  // happened to phrase the question. Ask "how many steps did I do?" and any number in the reply
  // passed — including one nobody held. Phrasing is not provenance.
  //
  // The evidence branch above is the legitimate version of what it was reaching for: a number we
  // hold for this client today is a recital and passes on its own, whatever words the question
  // used. The deterministic steps door now records that evidence, so the honest path is open and
  // the wording bypass is not.
  const reported = extractStepNumbers(clientMessage);
  if (reported.length === 0) {
    return { ok: false, violation: "Your reply attributes a step/walking number to the client, but their current message did not report a step count. Stored snapshot state is not a current-turn client statement. Do not say they walked or did a number of steps unless they reported it in this message; if they asked about progress, that is a different case and you may answer from state." };
  }
  if (replySteps.some(n => !reported.includes(n))) {
    return { ok: false, violation: "Your reply attributes a step count that is not one of the numbers the client reported in this message. Do not substitute a stored/context step value for the client's own current-turn number." };
  }
  return { ok: true };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * TRAINING-COUNT PROVENANCE — workoutLogs says 1, the model says 4 (2026-08-22, P0-1B)
 *
 * 21 August, handset:
 *
 *     14:36  client   "I did all four workouts this week / Take note"
 *     14:36  coach    "That's impressive — all four workouts done this week! Noted 👌"
 *     14:38  card      WORKOUTS 1
 *
 * The write-integrity rule in reconcileTurnReply catches the "Noted" half — a confirmation on a
 * turn that committed nothing. It does NOT catch the other half, and the other half is worse: the
 * coach agreed, in its own voice, with a training history the record contradicts. A client who is
 * told they trained four times when they trained once cannot use this product to know anything.
 *
 * This is deliberately NOT a list of the sentences that failed. It is the rule the step
 * attribution has followed since 20 August, applied to the second durable count we hold:
 *
 *     claim → source → value → context
 *
 *   source  workoutLogs, read this turn by getProgressTruth, left on the turn as sessionsWindow
 *   value   the claim's number must BE that number
 *   context the claim's window must be the window we counted — a 7-day count is not "this month",
 *           not "in total", not "since you started", and not "today"
 *
 * The fallback when we hold nothing is the step rule's fallback: a number the client themselves
 * put in this message may be echoed; a number from nowhere may not. Held state OUTRANKS the
 * client's own figure, which is the whole point — "I did all four" plus a log of one is exactly
 * the case, and agreeing with the client is what broke it.
 *
 * HONEST BOUND. The claim has to be RECOGNISED to be checked, and what is recognised is a number
 * next to a training noun ("four workouts", "sessions: 4", "your fourth session"). A bare
 * "that's four this week" with the noun only in the client's message is not caught. That is a
 * detection bound, not a licence: nothing here makes an unrecognised claim correct, and the
 * canonical-decision boundary above already withholds model prose entirely on a decision turn.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

function verifySessionAttribution(reply: string, clientMessage: string, evidence?: VerifierFacts["evidence"]): VerifierResult {
  // Deterministic replies recite counts they read themselves. Only model prose is held to this.
  if (!evidence?.modelAuthored) return { ok: true };
  // ONE OWNER for "how many sessions does this text assert" — the same reader the workout writer
  // consults before it refuses to invent rows. See utils.sessionCountsIn.
  const claimed = sessionCountsIn(withoutTargetSegments(reply));
  if (claimed.length === 0) return { ok: true };

  const held = evidence?.sessionsWindow;
  const windowDays = Number(evidence?.sessionsWindowDays) || 0;
  if (typeof held === "number" && windowDays > 0) {
    if (OUT_OF_WINDOW.test(reply)) {
      return { ok: false, violation: `Your reply states a training count for a period we did not count. What the record holds is ${held} session(s) in the last ${windowDays} days — nothing about a month, a year, or a lifetime total. Say the window we actually know, or say nothing about the count.` };
    }
    if (claimed.every(n => n === held)) return { ok: true };
    return { ok: false, violation: `Your reply says the client has done ${claimed[0]} training session(s), but the record holds ${held} in the last ${windowDays} days. Never confirm a training history the log contradicts — not even when the client states it themselves. Tell them plainly what is on the record and ask them to send the missing sessions so you can log them.` };
  }

  // Nothing held this turn: a figure the CLIENT put in this message may be echoed, nothing else.
  const reported = sessionCountsIn(clientMessage || "");
  if (reported.length === 0 || claimed.some(n => !reported.includes(n))) {
    return { ok: false, violation: "Your reply states a number of training sessions that is neither on the record nor in the client's message. Do not assert how many times someone has trained unless the count came from their log." };
  }
  return { ok: true };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * PRESCRIPTION PROVENANCE — a model may write the language, not invent the decision (2026-08-21)
 *
 * tellDontAsk was the only thing standing between the model and a decision, and it catches
 * exactly one shape: a question handed back to the client. So this was blocked —
 *
 *     "What do you think you should do?"          ← caught, replaced with the canonical move
 *
 * and this was not —
 *
 *     "Train chest today."                        ← no question mark. Already a decision.
 *     "Drop your calories to 1800."               ← a TARGET write, in prose
 *
 * The claim "GPT now prescribes through chooseAction" was therefore false for arbitrary model
 * output. This closes that, and it is deliberately NOT a phrase museum: the domains below are
 * the ActionKind taxonomy that already exists — come_back · rest · weigh · protein · eat_more ·
 * log · walk · train · hold — one signature per kind, a closed set defined by the decision owner
 * rather than by phrases invented here. When the taxonomy changes, this changes with it.
 *
 * WHAT IT DOES NOT TOUCH. Ordinary coaching language, answers to "can I eat this?", explanation,
 * encouragement, and anything a DETERMINISTIC handler wrote. A deterministic reply stating a
 * target is reciting state it owns; a model doing it is deciding. Only model-authored prose is
 * held to this.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/*
 * VALIDATION AGAINST THE CANONICAL DECISION ITSELF (2026-08-21, second correction).
 *
 * The first attempt was a table of one signature per ActionKind. That was prose classification
 * wearing a taxonomy: it proved six textual shapes were covered and nothing more. Worse, it did
 * not actually validate the coach's OWN instructions — "Make your next meal a proper protein
 * meal", "Log one meal today. Any meal." shipped because no signature fired, which is coincidence,
 * not provenance.
 *
 * The rule is now the relationship the order asks for:
 *
 *     chooseAction → canonicalTodo → GPT language → validated AGAINST that canonicalTodo
 *
 * A behaviour-changing directive in model prose is licensed only when it speaks to the SAME
 * behaviour the canonical decision named. When the decision named none — hold / CONTINUE — no
 * directive is licensed at all, which is the dangerous case: the model inventing an action on a
 * turn where the coach decided to change nothing.
 *
 * Two closed vocabularies, and deliberately no third:
 *   DOMAIN — the things this programme is about. Nouns, and the set is the product's, not a list
 *            of phrasings. The SAME matcher reads the canonical todo and the model's prose, so
 *            the comparison is between two texts rather than against a hand-written table.
 *   SHAPE  — the grammar of an instruction. Advisory ("you should", "I'd", "let's", "try to") or
 *            imperative (a bare verb opening a sentence). Grammar generalises; phrasings do not.
 *
 * Measured on plausible phrasings of the same prescriptions: 25/27 caught, 0/10 ordinary
 * sentences over-blocked. The two misses are recorded rather than chased — the fix for them is
 * structural, and adding signatures is the thing this rewrite exists to stop.
 */

/** The behaviours this programme can instruct. A closed set: what the product is about. */
const BEHAVIOUR_DOMAINS: Array<[string, RegExp]> = [
  // TRAINING AND REST ARE ONE AXIS, not two. Split, a canonical REST decision ("Rest today")
  // refused the model's natural expression of it ("You should skip training today", "I'd give the
  // gym a miss") because those name training. Whether to train IS the decision; rest is its other
  // face. Merging them is a smaller vocabulary and a correct one.
  ["training", /\b(gym|sessions?|workouts?|training|train|chest|legs?|back|shoulders?|arms?|push|pull|cardio|lift(?:ing)?|rest\s*day|rest|recover(?:y)?|day\s+off)\b/i],
  ["food",     /\b(protein|calories|kcal|intake|carbs?|meals?|eat(?:ing)?|food|breakfast|lunch|dinner|supper)\b/i],
  ["steps",    /\b(steps?|walk(?:ing|s)?|movement)\b/i],
  ["weight",   /\b(scale|weigh(?:ing|ed)?|weight)\b/i],
  ["logging",  /\b(log(?:ging)?|track(?:ing)?|record)\b/i],
];

const domainsIn = (text: string): Set<string> => {
  const found = new Set<string>();
  for (const [name, re] of BEHAVIOUR_DOMAINS) if (re.test(text)) found.add(name);
  return found;
};

/** The GRAMMAR of an instruction — advisory or imperative. Not a list of phrasings. */
const ADVISORY = /\b(?:you\s+(?:should|need\s+to|have\s+to|could|might\s+want\s+to|ought\s+to)|i'?d\s+\w+|let'?s\b|try\s+to\b|make\s+sure\b|aim\s+(?:to|for)\b|would\s+help\b|(?:it'?s|today\s+is)\s+a\s+good\s+(?:day|time)\s+(?:for|to)\b)/i;
const IMPERATIVE = /(?:^|[.!?]\s+|\n)\s*(?:train|do|hit|get|go|take|skip|rest|walk|weigh|eat|add|drop|lower|raise|push|bring|start|stop|keep|make|try|sit|jump|step|log|send)\b/i;

/** Is this sentence telling the client to change what they DO? */
function directiveDomains(sentence: string): Set<string> {
  const shaped = ADVISORY.test(sentence) || IMPERATIVE.test(sentence);
  return shaped ? domainsIn(sentence) : new Set<string>();
}

/**
 * THE SAME QUESTION, ASKED BY A COMPOSER RATHER THAN A VERIFIER (2026-08-22).
 *
 * The morning brief has narrative parts that are supposed to be RECOGNITION — a streak, a
 * milestone, a sign-off — and one part that is supposed to be the INSTRUCTION. One of the
 * sign-offs was quietly an instruction ("let's get one in today"), so a rest-day brief could
 * carry two. composeMorning enforces the separation with this, so it holds for every trajectory
 * and every one added later, rather than for the one branch that was caught.
 *
 * Exported rather than reimplemented: "is this English telling someone to do something" has one
 * owner and this is it. A second copy in the composer would drift from this one within a month.
 */
export function carriesDirective(sentence: string): boolean {
  return directiveDomains(sentence).size > 0;
}

/**
 * A TARGET WRITTEN IN PROSE. targets.ts is the only thing allowed to set a client's numbers, so
 * a model saying "drop to 1800" has both decided AND written to a domain it does not own. No
 * canonical decision can license it — chooseAction never sets a target either.
 */
const PROSE_TARGET_WRITE = /\b(?:drop|lower|reduce|cut|raise|increase|bump|set|change|move|push)\s+(?:your\s+)?(?:calories|kcal|intake|protein|steps?|target|goal)\b[^.!?]{0,40}?(?:\bto\b|\bdown\b|\bup\b|\bhigher\b|\blower\b)/i;

/**
 * REMOVE THE MODEL'S INSTRUCTION SO THE CANONICAL ONE CAN BE RENDERED IN ITS PLACE (2026-08-21).
 *
 * Blocking a whole reply because one sentence over-stepped throws away the empathy and the
 * explanation with it. What the architecture actually wants is narrower: the model supplies
 * context, and the BEHAVIOURAL INSTRUCTION is rendered deterministically from the canonical
 * decision. So the offending sentences come out and the canonical instruction goes on.
 *
 * Returns the surviving prose and what was removed. Used at the single outbound chokepoint, which
 * is the only place that sees every model exit — the four specialist agents and the punct/short/
 * frustration replies all return early and never reach the append at the end of gpt-block.
 */
/**
 * THE MODEL'S PROSE CARRIES NO INSTRUCTION AT ALL (2026-08-21, final boundary).
 *
 * WHAT WAS WRONG WITH THE PREVIOUS VERSION, and it was my own doing. It stripped only
 * *unlicensed* directives — a model sentence in the same behaviour DOMAIN as the canonical
 * decision was allowed through as "the model expressing the decision naturally". Two commits
 * earlier I had merged training and rest into one domain to stop a canonical REST decision
 * refusing "you should skip training today". Together those produced this, sent as one message:
 *
 *     "Go train today.
 *
 *      Rest today — your body is doing the work."
 *
 * Two contradictory instructions, licensed because they were the same domain. Same shape for
 * food: "You should skip dinner" survived beside "Make your next meal a proper protein meal".
 *
 * THE LICENSING CONCEPT WAS THE BUG. It existed so the model could express the decision in its
 * own words — but the decision is now RENDERED deterministically, so the model never needs to
 * express it, and letting it try is what created the contradiction. So: every directive sentence
 * the model writes comes out, and the canonical instruction goes on afterwards. The model keeps
 * what it is actually for — empathy, context, explanation, judgment — and the thing the client
 * is told to DO comes from one place.
 *
 * The residual bound is now a SINGLE question — did we recognise this sentence as an instruction
 * — rather than a semantic judgement about whether the model's instruction agreed with ours.
 */
export function stripModelDirectives(
  reply: string, evidence?: VerifierFacts["evidence"],
): { kept: string; removed: string[] } {
  if (!evidence?.modelAuthored) return { kept: reply, removed: [] };

  // THE CANONICAL SENTENCE ITSELF SURVIVES. On the paths that reach tellDontAsk it has already
  // been appended into the draft, and stripping the coach's own instruction would be absurd.
  const todo = String(evidence.canonicalTodo || "").trim().toLowerCase().replace(/[.!]$/, "");

  const removed: string[] = [];
  const kept = String(reply || "")
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .filter(sentence => {
      const t = sentence.trim().toLowerCase().replace(/[.!]$/, "");
      if (todo && (t === todo || t.includes(todo))) return true;
      if (directiveDomains(sentence).size === 0) return true;
      removed.push(sentence.trim());
      return false;
    })
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { kept, removed };
}

function verifyPrescriptionProvenance(reply: string, evidence?: VerifierFacts["evidence"]): VerifierResult {
  // Deterministic replies recite state they own. Only model prose is held to this.
  if (!evidence?.modelAuthored) return { ok: true };
  const r = reply || "";

  if (PROSE_TARGET_WRITE.test(r)) {
    return { ok: false, violation: "Your reply changes the client's target numbers in prose. Targets have one owner and you are not it — never tell a client to move their calories, protein or step target. Explain what their current targets mean if that helps, but do not set one." };
  }

  // THE CANONICAL DECISION, AS TEXT. Not a kind table — the actual instruction chooseAction
  // produced this turn, read by the same domain matcher that reads the model's prose.
  const todo = String(evidence.canonicalTodo || "");
  const licensed = domainsIn(todo);
  // A structured CoachAction the model committed to through the tool contract licenses its own
  // behaviour: SET_SICK is agreeing to a rest hold, END_SICK is the return to training.
  const structured = String(evidence.structuredAction || "");
  if (structured === "SET_SICK") licensed.add("rest");
  if (structured === "END_SICK") licensed.add("training");

  for (const sentence of r.split(/(?<=[.!?])\s+|\n+/)) {
    const domains = directiveDomains(sentence);
    if (domains.size === 0) continue;
    const unlicensed = [...domains].filter(d => !licensed.has(d));
    if (unlicensed.length === 0) {
      // The domain is licensed; the VALUE still is not. A figure the decision did not contain is
      // the model choosing a number — claim → source → value → context, the same rule the step
      // attribution follows.
      const quantities = sentence.match(/\b\d[\d,]*\s*(?:g|kcal|calories|steps?|kg|minutes?|mins?)\b/gi) || [];
      const invented = quantities.filter(q => !todo.toLowerCase().includes(q.toLowerCase()));
      if (invented.length > 0) {
        return { ok: false, violation: `Your reply instructs the client using a figure (${invented[0]}) the coaching decision did not contain. Instruct in food and actions, never in numbers you chose yourself.` };
      }
      continue;
    }
    return { ok: false, violation: todo
      ? `Your reply tells the client to change their ${unlicensed[0]}, but the coaching decision for this turn was "${todo}". You may explain, answer and encourage in your own words — the one thing to DO is decided upstream. Express that decision, do not add another.`
      : `Your reply tells the client to change their ${unlicensed[0]}, but no coaching decision was made this turn — the verdict was to change nothing. Answer them, encourage them, explain if they asked; do not introduce an instruction of your own.` };
  }
  return { ok: true };
}

export function verifyBrainReply(reply: string, facts: VerifierFacts, decisionOverride?: RuntimeDecisionResult): VerifierResult {
  const r = reply || "";
  const decision = decisionOverride || currentRuntimeDecision();
  if (decision) {
    const violation = decisionBoundaryViolation(r, decision);
    if (violation) return { ok: false, violation };
  }

  const medication = detectMedicationContext(facts.clientMessage || "");
  const medicationViolation = medicationBoundaryViolation(r, facts.clientMessage || "");
  if (medication.unsafeRequest) {
    forceRuntimeReferral();
  }
  if (medicationViolation) return { ok: false, violation: medicationViolation };

  if (/\b(?:cure|reverse|heal|get rid of|eliminate|fix)\s+(?:your\s+|the\s+|his\s+|her\s+)?(?:diabetes|diabetic|hypertension|high blood pressure|blood pressure|cholesterol|pcos|thyroid|arthritis|ibs|cancer|condition|illness|disease|diagnosis)\b/i.test(r)) {
    return { ok: false, violation: "Your reply claims to cure/reverse/heal a medical CONDITION. KamLife is a wellness coach, NOT a doctor or medical device — this is a compliance and liability breach and must NEVER be said. Rewrite: coach the healthy HABITS (movement, food, sleep, consistency) that support how they feel, and for anything about the condition itself defer to their doctor ('I'm your coach, not your doctor — your doctor guides the condition, I'll help you build the habits around it'). Never promise to cure, reverse or fix a disease." };
  }
  if (/\b(?:take|takes|taking|swallow|have)\s+(?:your |his |her |the |their )?(?:[a-z][\w-]*\s+){0,2}?(?:insulin|medication|meds|medicine|dose|doses|dosage|tablets?|pills?|metformin|statins?|arvs?|antiretrovirals?|treatment|prescription)\b[^.!?]{0,40}\b(?:with food|on an empty stomach|before (?:bed|meals?|eating|breakfast)|after (?:meals?|eating|breakfast|supper)|at night|in the morning|with (?:a )?meal|first thing)\b/i.test(r)) {
    return { ok: false, violation: "Your reply instructs the client on HOW or WHEN to take medication (with food, on an empty stomach, at night, before bed). That is a pharmacist's or doctor's job and never a coach's — remove it entirely. Say that the timing of their medicine is a question for their doctor or pharmacist, and coach only what you actually coach: the food, the training, the sleep, the consistency." };
  }
  if (/\b(?:stop|start|adjust|change|increase|reduce|lower|skip|come off|go off|wean off|double|halve|cut)\s+(?:your |his |her |the |taking )?(?:[a-z][\w-]*\s+){0,3}?(?:insulin|medication|meds|medicine|dose|dosage|tablets|pills|metformin|statins?|treatment|prescription)\b/i.test(r)) {
    return { ok: false, violation: "Your reply directs a change to the client's MEDICATION (stopping / adjusting / skipping a dose). You must NEVER touch medication — it is dangerous and outside a coach's scope. Rewrite: tell them only their doctor decides anything about their medication, and steer back to the habits you DO coach (food, movement, sleep). Remove any instruction about medicine, insulin or dose." };
  }
  if (/\b(muscle confusion|confus\w+ (?:the |your |that )?(?:muscle|muscles|focus|plan)|shock(?:ing)? (?:the |your )?muscles?|spot[- ]?reduc\w+|muscles? turn\w* (?:in)?to fat|fat turn\w* (?:in)?to muscle)\b/i.test(r)
      && !/\b(myth|no such thing|not (?:a )?real|isn'?t real|not (?:a )?thing|can'?t|cannot|doesn'?t work|false|nonsense|ignore that)\b/i.test(r)) {
    return { ok: false, violation: "Your reply invokes a fitness MYTH (muscle confusion / shocking the muscle / spot reduction / muscle-turns-to-fat). None of these are real — never tell a client to 'confuse' or 'shock' a muscle. Rewrite with the correct principle: progressive overload on the core lifts, and for a lagging body part, TARGETED VOLUME (a couple more sets, or one focused accessory) on that muscle." };
  }
  if (/\bexercises?\s+(?:like|such as|including)\b|\b(?:incorporate|throw in|mix in|start doing|add in|try (?:doing |adding |some ))\b[^.!?]{0,24}?\b(?:squats?|lunges?|deadlifts?|burpees?|crunches|sit[- ]?ups?|planks?|pull[- ]?ups?|chin[- ]?ups?|dips|mountain climbers?|kettlebell\w*|box jumps?|jumping jacks?|russian twists?|leg raises?|jump squats?|snatch\w*|clean(?:s| and jerks?)?)\b/i.test(r)) {
    return { ok: false, violation: "You prescribed exercises as if writing a workout ('exercises like…', 'incorporate squats and lunges'). The client's programme is FIXED and machine-based — you must NEVER invent, list, or suggest movements in a chat reply. To bring up a body part the answer is ALWAYS: targeted volume + progressive overload on the lifts they ALREADY have (add a rep or 2.5kg), plus the lagging muscle from their photo read in the numbers above — name the SPECIFIC weak part and one concrete number. If they want the actual plan, tell them to send *programme*. Rewrite now with no new exercises." };
  }
  if (/\bI(?:'?ll| will| am going to| can)\s+(?:adjust|update|change|increase|decrease|recalculate|reset)\s+(?:your\s+)?(?:targets?|goal|calories?|calorie target|protein target|programme|plan|macros)\b/i.test(r)
      || /\b(?:we(?:'?ll| will| are going to)?\s+(?:shift|switch|move|change)(?:\s+\w+){0,3}\s+to\s+(?:fat loss|muscle gain|cutting|bulking)|your goal is now|I(?:'?ve| have) (?:changed|updated|switched) your goal)\b/i.test(r)) {
    return { ok: false, violation: "You claimed the client's targets/goal/programme will change, but you have NO tool for that. Remove the claim; if they want it changed, tell them to say 'change my goal to …' so the system can confirm it properly." };
  }

  // ── Food-turn grounding (live 2026-08-19 McDonald's voice failure) ─────────
  // Client described a meal; coach said "no meal logged / what did you eat?" AND
  // invented precise kcal/protein. Reality before reasoning: never re-ask for a meal
  // already in the client message; never pair "nothing logged" with macro precision.
  const clientMsg = String(facts.clientMessage || "");
  // ONE OWNER FOR "DID THEY REPORT FOOD" (Cut 3). This was its own noun regex, and it matched
  // the word "meal" in "remove last meal" — so a management command counted as a food report.
  // Harmless while a rejected reply was sent anyway; the moment the verdict BINDS, it blocked a
  // legitimate reply and the client got "let me not guess on that one". A planning question
  // ("what should I order at KFC") misfired the same way.
  //
  // parseMessyIntake owns the report-vs-command distinction and answers no to both. Narrower
  // than the old regex on foods it does not know by name, and stated rather than hidden: this is
  // a grounding rule, not a safety one, and a false block is worse than a missed nudge.
  const clientHasFood = parseMessyIntake(clientMsg).hasFoodReport;
  const asksWhatAte = /\b(what did you eat|what have you eaten|i don'?t have a meal logged|no meal logged|nothing logged for you today|i have no meal logged)\b/i.test(r);
  const claimsMealMacros = /\b\d{2,5}\s*kcal\b/i.test(r) && /\b\d{1,3}\s*g(?:rams?)?\s*protein\b/i.test(r);
  if (clientHasFood && asksWhatAte) {
    return { ok: false, violation: "The client already described food in this message. Do NOT ask what they ate or claim no meal is logged. Log or confirm that food in their words; if amounts are unclear ask ONLY for the missing amount — never pretend the meal was not stated." };
  }
  if (asksWhatAte && claimsMealMacros) {
    return { ok: false, violation: "Contradiction: you said no meal is logged (or asked what they ate) and also stated precise kcal/protein. You cannot invent macros for a meal you claim is missing. Either log the stated food without fake precision, or ask one clarifying question with no numbers." };
  }
  if (clientHasFood && claimsMealMacros && asksWhatAte === false && /\bi don'?t have a meal logged\b/i.test(r) === false) {
    // Still block precise macros when we have no proof a log write happened this turn.
    // VerifierFacts does not yet carry mealLoggedThisTurn — treat unanchored precision as unsafe.
    if (!/\b(logged|on the log|in the books|saved)\b/i.test(r)) {
      return { ok: false, violation: "Client described food but your reply states precise kcal/protein without confirming a log write. Log first (or confirm amounts), then reply in their words. If estimating, say it is an estimate and do not treat it as logged truth." };
    }
  }

  // Live 14:22: meal just logged, then "a lot of fried/takeaway" + "grill it don't fry it".
  // Least intervention: confirm the log. Do not shame the plate they already ate.
  if (clientHasFood && /\b(that'?s a lot of fried\/?takeaway|grill it,? don'?t fry it|heavy on the hidden fat)\b/i.test(r)) {
    return { ok: false, violation: "Do not lecture a client about fried/takeaway on the turn they just described a meal. Confirm the log. Next-meal direction only — no shame about the plate already eaten." };
  }

  const prescription = verifyPrescriptionProvenance(r, facts.evidence);
  if (!prescription.ok) return prescription;

  const stepAttribution = verifyStepAttribution(r, facts.clientMessage || "", facts.evidence);
  if (!stepAttribution.ok) return stepAttribution;

  const sessionAttribution = verifySessionAttribution(r, facts.clientMessage || "", facts.evidence);
  if (!sessionAttribution.ok) return sessionAttribution;

  const goal = String(facts.goalType || "").toLowerCase();
  if (goal === "muscle_gain" && /\b(?:focus on (?:a )?calorie deficit|let'?s (?:focus on|aim for|target) (?:fat|weight) loss|we(?:'?ll| will)? (?:focus|aim|work) on losing (?:weight|fat)|great (?:progress|work|job)[^.!?]{0,40}\blos(?:ing|t)\b[^.!?]{0,20}\b(?:kg|weight)|keep losing|stay in (?:a|your) deficit)\b/i.test(r)) {
    return { ok: false, violation: "This client's goal is MUSCLE GAIN, but your reply pushes fat loss / a deficit / celebrates losing. Rewrite consistent with muscle gain (falling weight is a problem to fix, not progress)." };
  }
  if (goal === "fat_loss" && /\b(?:let'?s (?:focus on|aim for) (?:a )?(?:calorie )?surplus|eat (?:in a|at a) surplus|focus on bulking|let'?s bulk|aim to gain weight|we(?:'?ll| will)? (?:focus|work) on gaining (?:weight|mass|size))\b/i.test(r)) {
    return { ok: false, violation: "This client's goal is FAT LOSS, but your reply pushes a surplus / bulking / gaining. Rewrite consistent with fat loss." };
  }
  if (goal === "muscle_gain" && /\byour\s+(?:calorie\s+)?deficit\b/i.test(r)) return { ok: false, violation: "You called it 'your deficit' but this client is on a SURPLUS (muscle gain). Correct the frame kindly instead of mirroring their confusion." };
  if (goal === "fat_loss" && /\byour\s+(?:calorie\s+)?surplus\b/i.test(r)) return { ok: false, violation: "You called it 'your surplus' but this client is on a DEFICIT (fat loss). Correct the frame kindly instead of mirroring their confusion." };

  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// "DON'T TALK ABOUT THE SCALE" — THE ONE FACT WHOSE WHOLE VALUE IS BEING HONOURED
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// (2026-08-19, Cut 8.) Cut 7 started detecting this request and storing it in users.do_not_mention,
// and then told only the GPT context about it. Every deterministic path — the weigh-in ask, the
// progress reply, the morning decision — carried on saying the word.
//
// That is worse than the gap it replaced. Before Cut 7 we never heard the request; after it we
// hear it, record it, and visibly ignore it. Noticing what someone asked for and then doing it
// anyway is a broken promise, and this cut exists to close what Cut 7 opened.
//
// Pure, and deliberately in the verifier: this module already owns the question "may this reach a
// client", and it has no database or model, so the DECISION can import it without either.

/** Topics that are one topic. Asked not to mention "the scale", we must not say "weigh" either. */
const TOPIC_CLUSTERS: string[][] = [
  ["weight", "weigh", "weighed", "weighing", "weigh-in", "weighin", "scale", "scales", "kg", "kilos", "kilograms"],
  ["calories", "calorie", "kcal", "cals"],
];

/**
 * The pattern that means "this text names the thing they asked me to drop", or null when there is
 * nothing to honour. Word-bounded — "scale" must not fire on "escalate".
 */
export function forbiddenTopicPattern(doNotMention?: string | null): RegExp | null {
  const raw = (doNotMention || "").trim().toLowerCase();
  if (raw.length < 2 || raw.length > 60) return null;
  const asked = raw.split(/[,;]+| and /).map(s => s.trim()).filter(w => w.length >= 2);
  if (asked.length === 0) return null;

  const words = new Set<string>();
  for (const term of asked) {
    words.add(term);
    // One member of a cluster pulls in the rest — otherwise "don't mention the scale" is honoured
    // by a reply that says "let's get you weighed", which is the same sentence to the person who
    // asked. Terms outside every cluster are taken literally and nothing is inferred.
    for (const cluster of TOPIC_CLUSTERS) {
      if (cluster.some(c => c === term || term.includes(c))) cluster.forEach(c => words.add(c));
    }
  }
  const escaped = [...words].map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  // LETTER LOOKAROUNDS, NOT \b. "2kg" has no word boundary between the digit and the k, so \b
  // would silently fail on exactly the sentence this exists to catch — the identical mistake
  // replaceNumberToken in chat-log.ts carries a comment about, and the one the step-target P0
  // turned on. Guarding on letters still blocks a substring hit: "escalate" cannot match "scale"
  // because the preceding character is a letter.
  try { return new RegExp(`(?<![a-z])(?:${escaped.join("|")})(?![a-z])`, "i"); } catch { return null; }
}

export function mentionsForbidden(text: string, doNotMention?: string | null): boolean {
  const re = forbiddenTopicPattern(doNotMention);
  return !!re && re.test(String(text || ""));
}

export interface ForbiddenStripResult {
  /** What may be sent. "" when nothing substantive survived. */
  text: string;
  /** True when something was actually removed — the caller logs and escalates on this. */
  stripped: boolean;
}

/**
 * Remove the sentences that name the topic, and keep the rest of the reply.
 *
 * SENTENCE LEVEL ON PURPOSE. Blocking the whole reply — the Cut 3 treatment — would throw away a
 * correctly logged meal because the message happened to end with "weigh in tomorrow". Honouring
 * the request should cost the client the sentence, not the answer.
 *
 * A reply that is ENTIRELY about the topic strips to "", and the caller says so honestly instead
 * of sending an empty message.
 */
export function stripForbidden(reply: string, doNotMention?: string | null): ForbiddenStripResult {
  const re = forbiddenTopicPattern(doNotMention);
  const draft = String(reply || "");
  if (!re || !re.test(draft)) return { text: draft, stripped: false };

  // Split on bubble breaks first — `\n\n---\n\n` is a separate WhatsApp message, so a bubble that
  // is entirely about the topic must go whole rather than leave a stub behind.
  const bubbles = draft.split("\n\n---\n\n").map(bubble =>
    bubble.split("\n").map(line => {
      if (!re.test(line)) return line;
      const kept = line.split(/(?<=[.!?])\s+/).filter(s => !re.test(s));
      return kept.join(" ").trim();
    }).filter(l => l !== "" || false).join("\n").trim()
  ).filter(b => b.length > 0);

  const text = bubbles.join("\n\n---\n\n").replace(/\n{3,}/g, "\n\n").trim();
  // A leftover that is only punctuation, an emoji or a bare "*" is not an answer.
  return { text: /[a-z0-9]{3}/i.test(text) ? text : "", stripped: true };
}

/** What we say when the entire reply was about the thing they asked us to drop. */
export const HONOURED_SILENCE = "You asked me to leave that one alone, so I will. Tell me what you ate and we work from there.";
