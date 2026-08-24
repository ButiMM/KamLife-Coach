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
export type SituationKind = "celebration_outing" | "celebration" | "eating_out" | "food_closed" | "";

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
const WEEKEND_RE = /\bweekend\b/i;
const RECENT_DAY_PAST_RE = /\b(yesterday|last night)\b/i;

function sastWeekday(now: Date): string {
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    weekday: "short",
  }).format(now);
}

function sastCalendarDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function ageMoment(at: Date, now: Date): SituationMoment {
  const ageDays = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  if (ageDays <= 0) return "today";
  if (ageDays === 1) return "last_night";
  return "stale";
}

/** Resolve the time of the situation expressed by one message. */
export function resolveSituationMoment(text: string, at: Date, now = new Date()): SituationMoment {
  const raw = String(text || "").trim();
  const explicitPast = EXPLICIT_PAST_NIGHT_RE.test(raw) || EXPLICIT_PAST_RE.test(raw);
  const senderDay = sastCalendarDay(at);
  const currentDay = sastCalendarDay(now);

  // "birthday weekend was..." on Monday is the just-finished weekend unless the client explicitly
  // said "last weekend", which must remain age-based so it can become stale a week later.
  if (WEEKEND_RE.test(raw) && explicitPast && !EXPLICIT_PAST_NIGHT_RE.test(raw) && /^(Mon|Tue)$/i.test(sastWeekday(now))) {
    return "last_night";
  }

  // "yesterday" and "last night" are immediate retrospective references; "last weekend" ages normally.
  if (RECENT_DAY_PAST_RE.test(raw)) {
    const age = ageMoment(at, now);
    return age === "today" ? "last_night" : age;
  }

  if (EXPLICIT_PAST_NIGHT_RE.test(raw)) return ageMoment(at, now);

  if (EXPLICIT_TODAY_RE.test(raw)) {
    if (senderDay === currentDay) return explicitPast ? ageMoment(at, now) : "today";

    const senderDate = new Date(`${senderDay}T12:00:00Z`).getTime();
    const currentDate = new Date(`${currentDay}T12:00:00Z`).getTime();
    const diffDays = Math.floor((currentDate - senderDate) / 86_400_000);
    if (diffDays === 1) return "last_night";
    if (diffDays > 1) return "stale";
  }

  if (explicitPast && /\b(?:weekend|last night|yesterday)\b/i.test(raw) && /^(Mon|Tue)$/i.test(sastWeekday(now))) {
    return "last_night";
  }

  if (explicitPast) return ageMoment(at, now);
  return ageMoment(at, now);
}

export function classifySituationMessage(text: string, at: Date, now = new Date()): ResolvedSituation {
  const raw = String(text || "").trim();
  const birthday = CELEBRATION_RE.test(raw);
  const eatingOut = OUTING_RE.test(raw);
  const foodClosed = FOOD_CLOSED_RE.test(raw);

  let kind: SituationKind = "";
  if (birthday && eatingOut) kind = "celebration_outing";
  else if (birthday && WEEKEND_RE.test(raw)) kind = "celebration";
  else if (eatingOut) kind = "eating_out";
  else if (foodClosed) kind = "food_closed";

  if (!kind) return { kind: "", moment: "", sourceText: "" };
  return { kind, moment: resolveSituationMoment(raw, at, now), sourceText: raw };
}

export function resolveRecentSituation(messages: StampedSituationMessage[], now = new Date()): ResolvedSituation {
  const candidates = messages
    .map(message => ({ message, situation: classifySituationMessage(message.text, message.at, now) }))
    .filter(({ situation }) => situation.kind && situation.moment !== "stale")
    .sort((a, b) => b.message.at.getTime() - a.message.at.getTime());

  return candidates[0]?.situation || { kind: "", moment: "", sourceText: "" };
}