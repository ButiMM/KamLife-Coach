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

const WORD_NUM: Record<string, number> = {
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

    if (foodHit && FOOD_NOUN.test(beat + " " + text)) {
      hasFood = true;
      if (!foodText) foodText = beat;
      intents.push({ kind: "food_report", text: beat });
    } else if (stepsHit) {
      hasSteps = true;
      const c = extractStepCount(beat) ?? stepCount;
      intents.push({ kind: "steps_report", count: c, text: beat });
    } else if (feelHit) {
      hasFeeling = true;
      intents.push({ kind: "feeling", text: beat });
    } else {
      intents.push({ kind: "other", text: beat });
    }
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
  const branded =
    /\b(mcdonald'?s?|kfc|nando'?s?|spur|steers|wimpy|takeaways?|mocha)\b/i.test(text) ||
    (/\b(breakfast|lunch|dinner|supper)\b/i.test(text) && FOOD_VERB.test(text));
  const mustForceFoodLog = hasFood || (FOOD_VERB.test(text) && branded);

  return {
    intents,
    hasFoodReport: hasFood || mustForceFoodLog,
    hasStepsReport: hasSteps,
    hasFeeling,
    mustForceFoodLog,
    stepCount,
    foodText: foodText || (mustForceFoodLog ? text : null),
    isRetro: /\b(yesterday|last night|last evening)\b/i.test(text),
  };
}

/** Walk mentioned with no parseable count — do not drop the movement. */
export function mentionedWalkWithoutCount(message: string): boolean {
  const r = parseMessyIntake(message);
  return r.hasStepsReport && r.stepCount == null && /\b(walked|walking|walk)\b/i.test(message || "");
}

/** One reply from the parts we actually handled. Empty parts omitted. */
export function composeMessyAck(parts: { food?: string | null; steps?: string | null; feeling?: boolean }): string {
  const out: string[] = [];
  if (parts.food && parts.food.trim()) out.push(parts.food.trim());
  if (parts.steps && parts.steps.trim()) out.push(parts.steps.trim());
  if (parts.feeling) {
    out.push("Heard you on how you're feeling. Showing up still counts. Next move stays small.");
  }
  return out.join("\n\n");
}
