/**
 * MESSY-LIFE INTAKE — pure, deterministic parse of one human note into intents.
 *
 * Product core: clients send long voice notes about what they ate, walked, and how
 * they feel. This module is the owned front door for that shape. It does NOT write
 * to the DB and does NOT call the model. Handlers use the result to:
 *   - force the food log path (never freeform coach on a stated meal)
 *   - keep compound steps+food from dropping half the note
 *   - leave feeling to the coach without inventing macros
 *
 * Journey fixtures this must keep green:
 *   1. "I had a McDonald's SA breakfast with a mocha"
 *   2. "Yesterday I ate pap and chicken, walked about 8 thousand steps, I'm exhausted"
 */

export type MessyFoodReport = {
  kind: "food_report";
  /** Span most likely to contain the meal wording */
  text: string;
};

export type MessyStepsReport = {
  kind: "steps_report";
  count: number | null;
  text: string;
};

export type MessyFeeling = {
  kind: "feeling";
  text: string;
};

export type MessyIntent = MessyFoodReport | MessyStepsReport | MessyFeeling | { kind: "other"; text: string };

export interface MessyIntakeResult {
  intents: MessyIntent[];
  hasFoodReport: boolean;
  hasStepsReport: boolean;
  hasFeeling: boolean;
  /** A completed session. First-class because "I trained and had chicken" dropped the meal:
   *  handleWorkoutCommands returned the turn at routes.ts:872 and food never ran. */
  hasWorkoutReport: boolean;
  /** Water is a fact, not a special case bolted onto the food branch. */
  hasWaterReport: boolean;
  /** Which fact types this one note carries. Two or more means no single handler owns the turn. */
  factTypes: TurnFact[];
  /** Stated meal / branded takeaway — food path must own the turn (log or one clarify). */
  mustForceFoodLog: boolean;
  /** Extracted step count when present (digit or word number). */
  stepCount: number | null;
  foodText: string | null;
  /** Named yesterday / last night — log to that day, not today. */
  isRetro: boolean;
}

const FOOD_VERB =
  /\b(i\s+)?(ate|eaten|had|having|just\s+had|just\s+ate|for\s+breakfast|for\s+lunch|for\s+dinner|for\s+supper|breakfast\s+was|lunch\s+was|dinner\s+was)\b/i;
const FOOD_NOUN =
  /\b(breakfast|lunch|dinner|supper|brunch|snack|meal|mcdonald'?s?|kfc|nando'?s?|spur|steers|wimpy|takeaways?|take\s*away|pap|chicken|eggs?|mocha|coffee|bread|toast|rice|mince|wors|boerewors|pizza|burger|chips)\b/i;
const STEPS =
  /\b(steps?|walked|walking|ran\s+\d|\d+\s*km)\b/i;
const FEELING =
  /\b(tired|exhausted|stressed|stress|feel(?:ing)?|felt|anxious|motivat|struggling|overwhelmed|drained|hard\s+day|rough\s+day|not\s+coping)\b/i;
// A REPORTED SESSION, not a request for one. "send me my workout" is a command and stays with
// the workout handler alone; "I trained chest" is a fact that has to coexist with the meal.
const WORKOUT =
  /\b(trained|training\s+done|worked\s+out|workout\s+done|did\s+(?:my|the)\s+(?:workout|session|gym)|session\s+done|hit\s+(?:the\s+)?gym|went\s+to\s+(?:the\s+)?gym|benched|squatted|deadlifted|leg\s+day|chest\s+day|back\s+day|arm\s+day|push\s+day|pull\s+day)\b/i;
// PLANNING IS NOT A REPORT. "Going to KFC for lunch, what should I order?" matched FOOD_VERB on
// "for lunch" and FOOD_NOUN on "kfc", so the parser called an unmade decision a logged meal. That
// is wrong on its own terms — the ledger must never commit food the client has not eaten — and it
// also misfired the reply verifier, which blocked the ordering guide for quoting menu macros.
const PLANNING =
  /\b(going to|about to|thinking of|planning to|what should i|should i (?:get|order|have|eat)|gonna|i'?ll (?:have|get|order)|later|tonight i'?ll)\b/i;
const EATEN =
  /\b(ate|eaten|had|having|just had|just ate|finished)\b/i;
const WATER =
  /\b(\d+\s*(?:l|litres?|liters?)\b|litres?\s+of\s+water|liters?\s+of\s+water|glasses?\s+of\s+water|drank\s+water|drinking\s+water)\b/i;

/** Spoken number words. Exported because routes.ts kept a second, smaller copy of this table
 *  for its own step parser — two tables for one fact is how they drift. */
export const WORD_NUM: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
};

function extractStepCount(text: string): number | null {
  const t = text.toLowerCase();
  // 8000 steps / 8,000 steps
  const digit = t.match(/\b(\d{1,2}[,\s]?\d{3})\s*steps?\b/) || t.match(/\b(\d{3,5})\s*steps?\b/);
  if (digit) {
    const n = Number(digit[1].replace(/[,\s]/g, ""));
    if (Number.isFinite(n) && n > 0 && n < 200000) return Math.round(n);
  }
  // eight thousand steps / 8 thousand steps
  const word = t.match(
    /\b(?:(\d+)\s+)?(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen)?\s*(thousand|hundred)?\s*steps?\b/,
  );
  if (word) {
    const lead = word[1] ? Number(word[1]) : 0;
    const w = word[2] ? WORD_NUM[word[2]] || 0 : 0;
    const scale = word[3] === "thousand" ? 1000 : word[3] === "hundred" ? 100 : 1;
    const base = lead || w;
    const n = scale > 1 ? base * scale : w || lead;
    if (n > 0 && n < 200000) return n;
  }
  // "walked about eight thousand"
  const about = t.match(/\b(?:walked|walking)\s+(?:about\s+|around\s+)?(\d{3,5})\b/);
  if (about) {
    const n = Number(about[1]);
    if (n > 0 && n < 200000) return n;
  }
  const aboutWord = t.match(
    /\b(?:walked|walking)\s+(?:about\s+|around\s+)?(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|one|two|three|four|five|six|seven|eight|nine|ten)\s*(thousand|hundred)?\b/,
  );
  if (aboutWord) {
    const w = WORD_NUM[aboutWord[1]] || 0;
    const scale = aboutWord[2] === "thousand" ? 1000 : aboutWord[2] === "hundred" ? 100 : 1;
    const n = w * scale;
    if (n > 0) return n;
  }
  return null;
}

function splitBeats(message: string): string[] {
  const raw = (message || "").trim();
  if (!raw) return [];
  // Sentence / conjunction beats without destroying "and a mocha"
  const parts = raw
    .split(/(?<=[.!?])\s+|\b(?:and then|after that|also|plus|yesterday|this morning)\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  return parts.length ? parts : [raw];
}

/**
 * Parse one client message into messy-life intents. Deterministic. No I/O.
 */
export function parseMessyIntake(message: string): MessyIntakeResult {
  const text = (message || "").trim();
  const intents: MessyIntent[] = [];
  if (!text) {
    return {
      intents: [],
      hasFoodReport: false,
      hasStepsReport: false,
      hasFeeling: false,
      hasWorkoutReport: false,
      hasWaterReport: false,
      factTypes: [],
      mustForceFoodLog: false,
      stepCount: null,
      foodText: null,
      isRetro: false,
    };
  }

  const beats = splitBeats(text);
  let foodText: string | null = null;
  let stepCount: number | null = extractStepCount(text);
  let hasFood = false;
  let hasSteps = false;
  let hasFeeling = false;

  for (const beat of beats) {
    const foodHit = FOOD_VERB.test(beat) || (FOOD_NOUN.test(beat) && FOOD_VERB.test(text));
    const stepsHit = STEPS.test(beat) || extractStepCount(beat) != null;
    const feelHit = FEELING.test(beat);

    // ONE BEAT CAN CARRY SEVERAL FACTS. This was an `else if` chain, so the first thing a beat
    // matched was the only thing recorded — the same first-match-wins disease as the router, one
    // level down. "I had a mocha and I've just walked" matched food, and the walk was never a
    // steps report at all, so mentionedWalkWithoutCount could not see it and the movement was
    // silently dropped before any handler ran.
    let matched = false;
    if (foodHit && FOOD_NOUN.test(beat + " " + text)) {
      hasFood = true;
      if (!foodText) foodText = beat;
      intents.push({ kind: "food_report", text: beat });
      matched = true;
    }
    if (stepsHit) {
      hasSteps = true;
      const c = extractStepCount(beat) ?? stepCount;
      intents.push({ kind: "steps_report", count: c, text: beat });
      matched = true;
    }
    if (feelHit) {
      hasFeeling = true;
      intents.push({ kind: "feeling", text: beat });
      matched = true;
    }
    if (!matched) intents.push({ kind: "other", text: beat });
  }

  // Whole-message fallback: short branded meal with no beat split
  if (!hasFood && FOOD_VERB.test(text) && FOOD_NOUN.test(text)) {
    hasFood = true;
    foodText = text;
    intents.unshift({ kind: "food_report", text });
  }
  if (!hasSteps && stepCount != null) {
    hasSteps = true;
  }
  if (!hasFeeling && FEELING.test(text)) {
    hasFeeling = true;
  }

  // McDonald's / breakfast + eating verb = force food path even if scanner DB is empty
  // A planning message with no past-tense eating verb reports nothing yet.
  if (PLANNING.test(text) && !EATEN.test(text)) {
    hasFood = false;
    foodText = null;
  }

  const branded =
    /\b(mcdonald'?s?|kfc|nando'?s?|spur|steers|wimpy|takeaways?|mocha)\b/i.test(text) ||
    (/\b(breakfast|lunch|dinner|supper)\b/i.test(text) && FOOD_VERB.test(text));
  const mustForceFoodLog = hasFood && (branded || FOOD_VERB.test(text));

  const hasWorkout = WORKOUT.test(text);
  const hasWater = WATER.test(text);
  const factTypes: TurnFact[] = [];
  if (hasWorkout) factTypes.push("workout");
  if (hasSteps || stepCount != null) factTypes.push("steps");
  if (hasWater) factTypes.push("water");
  if (hasFood || mustForceFoodLog) factTypes.push("food");
  if (hasFeeling) factTypes.push("feeling");

  return {
    intents,
    hasFoodReport: hasFood || mustForceFoodLog,
    hasStepsReport: hasSteps,
    hasFeeling,
    hasWorkoutReport: hasWorkout,
    hasWaterReport: hasWater,
    factTypes,
    mustForceFoodLog,
    stepCount,
    foodText: foodText || (mustForceFoodLog ? text : null),
    isRetro: /\b(yesterday|last night|last evening)\b/i.test(text),
  };
}

/**
 * THE FOOD TABLE KNOWS MORE FOODS THAN FOOD_NOUN DOES.
 *
 * FOOD_NOUN above is a short hand-written list — pap, chicken, eggs, the branded takeaways. It
 * does not know "apple" or "pear", and the moment the ledger started deciding the turn on
 * `factTypes`, that gap became a dropped meal: "I had an apple and a pear and one litre of water"
 * parsed as water ONLY, so water was a single-fact note, it ended the turn, and the fruit was
 * gone. Adding apple and pear to the list would only move the edge.
 *
 * This module stays pure — it cannot import the scanner without a cycle (food-scanner →
 * unlogged-notice → here). So the caller, which already holds the authoritative scanner result,
 * merges it in. Rebuilt in canonical TURN_FACTS order so composition never depends on the order
 * a fact was discovered.
 */
export function withKnownFood(result: MessyIntakeResult, scannerSawFood: boolean): MessyIntakeResult {
  if (!scannerSawFood || result.hasFoodReport) return result;
  const present = new Set<TurnFact>([...result.factTypes, "food"]);
  return {
    ...result,
    hasFoodReport: true,
    factTypes: TURN_FACTS.filter(f => present.has(f)),
  };
}

/** Walk mentioned with no parseable count — do not drop the movement. */
export function mentionedWalkWithoutCount(message: string): boolean {
  const r = parseMessyIntake(message);
  return r.hasStepsReport && r.stepCount == null && /\b(walked|walking|walk)\b/i.test(message || "");
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE TURN LEDGER — every fact a note carries gets committed; nothing ends the turn early.
//
// (Cut 1.) What this replaces: routes.ts was a chain of ~13 `return` statements. The first
// handler that recognised anything answered the client and ended the turn, and the rest of the
// sentence stopped existing. Multi-intent was faked by threading a string called `stepReplyPart`
// through the chain and hand-stitching specific PAIRS — food+steps, food+water, food+feeling.
// Seven fact types is twenty-one pairs, so the founder found the missing ones one voice note at a
// time. "I trained chest and had chicken and pap" dropped the meal, because workout+food was
// never written as a pair.
//
// A handler now COMMITS what it did and returns control. This ledger holds the commits and one
// composer turns them into one reply. Adding a fact type does not require touching any other
// fact type — which is the property the pair-stitching never had.
// ════════════════════════════════════════════════════════════════════════════════════════════

// `other` is what a handler ABOVE the five fact types committed — a supplement taken, a training
// mode switched. It exists so early-commands can COMMIT instead of standing down: on
// "had 2 litres of water and took my creatine" the supplement confirmation is a fact the client
// told us, and a handler that recognised it must not end the turn to say so.
export const TURN_FACTS = ["workout", "other", "steps", "water", "food", "feeling"] as const;
export type TurnFact = (typeof TURN_FACTS)[number];

export interface TurnLedger {
  /** Confirmation text per fact, in the order the handlers ran. */
  parts: Partial<Record<TurnFact, string>>;
  /** Facts the parser saw in the note, whether or not a handler managed to commit them. */
  expected: TurnFact[];
}

export function newTurnLedger(expected: TurnFact[] = []): TurnLedger {
  return { parts: {}, expected };
}

/** Record what a handler actually did. Empty or duplicate commits are ignored. */
export function commitFact(ledger: TurnLedger, fact: TurnFact, text: string | null | undefined): void {
  const t = String(text ?? "").trim();
  if (!t || ledger.parts[fact]) return;
  ledger.parts[fact] = t;
}

export function committedCount(ledger: TurnLedger): number {
  return Object.keys(ledger.parts).length;
}

/**
 * THE ONLY OUTBOUND ASSEMBLER for a multi-fact note.
 *
 * Order is fixed and deliberate — what they DID, then what they drank/ate, then how they feel —
 * so two clients with the same facts get the same shape, and the reply does not reorder itself
 * depending on which handler happened to run first.
 *
 * `\n\n` and never `\n\n---\n\n`: the latter splits into separate WhatsApp messages, separately
 * billed, which is the multi-message problem this cut exists to end.
 */
export function composeMessyAck(ledger: TurnLedger): string {
  const out: string[] = [];
  for (const fact of TURN_FACTS) {
    const part = ledger.parts[fact];
    if (part) out.push(part.replace(/\[BUTTONS:[^\]]*\]\s*$/, "").trim());
  }
  return out.filter(Boolean).join("\n\n");
}

/** The deterministic feeling line. Acknowledges without inventing state or handing the turn to
 *  freeform, which is how a "how are you feeling" reply used to start asserting macros. */
export const FEELING_ACK = "Heard you on how you're feeling. Showing up still counts. Next move stays small.";

/**
 * Every fact has had its chance to commit — what goes out?
 *
 * `reply` is the one composed message, or null when the turn should continue to Coach K. A
 * genuine coaching QUESTION riding with the facts continues: the logs are already written and
 * their confirmations are in the ledger, so the question is answered by someone who knows what
 * just happened rather than instead of it.
 */
export function resolveTurn(
  ledger: TurnLedger,
  opts: { hasFeeling: boolean; alsoAsksCoach: boolean },
): { reply: string | null; committed: string } {
  if (opts.hasFeeling && !opts.alsoAsksCoach) commitFact(ledger, "feeling", FEELING_ACK);
  const committed = Object.keys(ledger.parts).join("+");
  if (committedCount(ledger) === 0) return { reply: null, committed };
  if (opts.alsoAsksCoach) return { reply: null, committed };
  return { reply: composeMessyAck(ledger) || null, committed };
}


/**
 * REBUILD GATE — the three facts in a messy note cannot be dropped because a classifier
 * called the whole turn a question. This is the product, not a helper.
 */
export function journeyMustKeepFacts(message: string): {
  food: boolean;
  steps: boolean;
  stepCount: number | null;
  feeling: boolean;
  isRetro: boolean;
  /** Explicit step count still logs even if the note was classified as QUESTION. */
  logStepsEvenIfClassifiedQuestion: boolean;
} {
  const r = parseMessyIntake(message);
  const explicitSteps = r.stepCount != null && r.stepCount > 100;
  return {
    food: r.hasFoodReport,
    steps: r.hasStepsReport || explicitSteps,
    stepCount: r.stepCount,
    feeling: r.hasFeeling,
    isRetro: r.isRetro,
    logStepsEvenIfClassifiedQuestion: explicitSteps,
  };
}
