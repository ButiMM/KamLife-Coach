/**
 * Day-relative situation resolver.
 *
 * Event identity and event timing are separate facts. A message such as
 * "the birthday weekend was hectic, so we're thinking about skipping today" must not
 * turn a completed weekend into a current-day outing merely because the same sentence
 * contains the word "today".
 *
 * Pure module. Existing memory storage/retrieval remains the owner of persistence.
 */

export type SituationMoment = "today" | "last_night" | "stale" | "";
export type SituationKind = "celebration_outing" | "eating_out" | "food_closed" | "";

export interface StampedSituationMessage {
  text: string;
  at: Date;
}

export interface ResolvedSituation {
  kind: SituationKind;
  moment: SituationMoment;
  sourceText: string;
}

const CELEBRATION_RE = /\b(birthday|anniversary|wedding)\b/i;
const OUTING_RE = /\b(restaurants?|eating out|going out to eat|go out to eat|outing|date night)\b/i;
const FOOD_CLOSED_RE = /\b(won'?t be able to eat|not going to eat anymore|not gonna eat anymore|no more food|done eating|drinks only|zero[- ]calorie drinks)\b/i;
const EXPLICIT_TODAY_RE = /\b(today|tonight|this afternoon|this evening)\b/i;
const EXPLICIT_PAST_RE = /\b(was|were|happened|already happened|finished|ended|we went|we had|we did)\b/i;
const EXPLICIT_PAST_NIGHT_RE = /\b(yesterday|last night|last weekend|previous weekend)\b/i;
const THIS_WEEKEND_RE = /\bthis weekend\b/i;

function sastWeekday(now: Date): string {
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    weekday: "short",
  }).format(now);
}

function ageMoment(at: Date, now: Date): SituationMoment {
  const ageDays = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  if (ageDays <= 0) return "today";
  if (ageDays === 1) return "last_night";
  return "stale";
}

/**
 * Resolve the time of the situation expressed by one message.
 * Explicit retrospective language beats a co-occurring "today" word.
 */
export function resolveSituationMoment(text: string, at: Date, now = new Date()): SituationMoment {
  const raw = String(text || "").trim();
  const explicitPast = EXPLICIT_PAST_NIGHT_RE.test(raw) || EXPLICIT_PAST_RE.test(raw);

  // On Monday/Tuesday, a retrospective "this weekend was..." refers to the just-finished
  // weekend. Do not let the word "today" elsewhere in that sentence promote it back to today.
  if (THIS_WEEKEND_RE.test(raw) && explicitPast && /^(Mon|Tue)$/i.test(sastWeekday(now))) {
    return "last_night";
  }

  if (explicitPast) return ageMoment(at, now);
  if (EXPLICIT_TODAY_RE.test(raw)) return "today";
  return ageMoment(at, now);
}

export function classifySituationMessage(text: string, at: Date, now = new Date()): ResolvedSituation {
  const raw = String(text || "").trim();
  const birthday = CELEBRATION_RE.test(raw);
  const eatingOut = OUTING_RE.test(raw);
  const foodClosed = FOOD_CLOSED_RE.test(raw);

  let kind: SituationKind = "";
  if (birthday && eatingOut) kind = "celebration_outing";
  else if (eatingOut) kind = "eating_out";
  else if (foodClosed) kind = "food_closed";

  if (!kind) return { kind: "", moment: "", sourceText: "" };
  return { kind, moment: resolveSituationMoment(raw, at, now), sourceText: raw };
}

/** Pick the newest relevant situation while preserving the message that produced it. */
export function resolveRecentSituation(
  messages: StampedSituationMessage[],
  now = new Date(),
): ResolvedSituation {
  const candidates = messages
    .map(message => ({ message, situation: classifySituationMessage(message.text, message.at, now) }))
    .filter(({ situation }) => situation.kind && situation.moment !== "stale")
    .sort((a, b) => b.message.at.getTime() - a.message.at.getTime());

  return candidates[0]?.situation || { kind: "", moment: "", sourceText: "" };
}
