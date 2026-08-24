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
  return new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short" }).format(now);
}
function sastCalendarDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function ageMoment(at: Date, now: Date): SituationMoment {
  const ageDays = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  if (ageDays <= 0) return "today";
  if (ageDays === 1) return "last_night";
  return "stale";
}

export function resolveSituationMoment(text: string, at: Date, now = new Date()): SituationMoment {
  const raw = String(text || "").trim();
  const explicitPast = EXPLICIT_PAST_NIGHT_RE.test(raw) || EXPLICIT_PAST_RE.test(raw);
  const senderDay = sastCalendarDay(at);
  const currentDay = sastCalendarDay(now);
  if (WEEKEND_RE.test(raw) && explicitPast && !EXPLICIT_PAST_NIGHT_RE.test(raw) && /^(Mon|Tue)$/i.test(sastWeekday(now))) return "last_night";
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
  if (explicitPast && /\b(?:weekend|last night|yesterday)\b/i.test(raw) && /^(Mon|Tue)$/i.test(sastWeekday(now))) return "last_night";
  return explicitPast ? ageMoment(at, now) : ageMoment(at, now);
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
  const candidates = messages.map(message => ({ message, situation: classifySituationMessage(message.text, message.at, now) }))
    .filter(({ situation }) => situation.kind && situation.moment !== "stale")
    .sort((a, b) => b.message.at.getTime() - a.message.at.getTime());
  return candidates[0]?.situation || { kind: "", moment: "", sourceText: "" };
}

export interface AttributedBeat {
  text: string;
  dayKey: string | null;
  confidence: "explicit" | "relative" | "inferred" | "ambiguous";
  dayReference: string | null;
}
export interface MultiDayAttribution {
  beats: AttributedBeat[];
  ambiguous: boolean;
  hasMultipleDays: boolean;
}
const SAST_TIMEZONE = "Africa/Johannesburg";
const DAY_WORDS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
function attributionDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SAST_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function attributionSastParts(date: Date): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: SAST_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || "";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), weekday: DAY_WORDS[get("weekday").toLowerCase()] ?? 0 };
}
function attributionShiftDays(date: Date, days: number): Date {
  const parts = attributionSastParts(date);
  const noonUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
  noonUtc.setUTCDate(noonUtc.getUTCDate() + days);
  return noonUtc;
}
function resolveAttributionReference(token: string, now: Date): { dayKey: string | null; confidence: AttributedBeat["confidence"] } {
  const t = token.toLowerCase().trim();
  if (/^(today|this morning|this afternoon|this evening|tonight)$/.test(t)) return { dayKey: attributionDateKey(now), confidence: "relative" };
  if (/^(yesterday|last night)$/.test(t)) return { dayKey: attributionDateKey(attributionShiftDays(now, -1)), confidence: "relative" };
  const dayMatch = t.match(/^(this|last|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (dayMatch) {
    const mode = dayMatch[1], target = DAY_WORDS[dayMatch[2]], current = attributionSastParts(now).weekday;
    let delta = (target - current + 7) % 7;
    if (mode === "last") delta = delta === 0 ? -7 : delta - 7;
    else if (mode === "this") { if (delta > 0) delta -= 7; }
    else return { dayKey: null, confidence: "ambiguous" };
    return { dayKey: attributionDateKey(attributionShiftDays(now, delta)), confidence: "explicit" };
  }
  const bareDay = t.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (bareDay) {
    const target = DAY_WORDS[bareDay[1]], current = attributionSastParts(now).weekday;
    let delta = (target - current + 7) % 7; if (delta > 0) delta -= 7;
    return { dayKey: attributionDateKey(attributionShiftDays(now, delta)), confidence: "explicit" };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const d = new Date(`${t}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? { dayKey: null, confidence: "ambiguous" } : { dayKey: t, confidence: "explicit" };
  }
  const dmy = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (dmy) {
    const year = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    const iso = `${String(year).padStart(4, "0")}-${String(Number(dmy[2])).padStart(2, "0")}-${String(Number(dmy[1])).padStart(2, "0")}`;
    const parsed = new Date(`${iso}T12:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? { dayKey: null, confidence: "ambiguous" } : { dayKey: iso, confidence: "explicit" };
  }
  return { dayKey: null, confidence: "ambiguous" };
}
function splitAttributionReferences(message: string): Array<{ text: string; reference: string | null }> {
  const matches: Array<{ index: number; length: number; token: string }> = [];
  const patterns = [
    /\b(?:today|this morning|this afternoon|this evening|tonight|yesterday|last night)\b/gi,
    /\b(?:this|last|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    /\b(?:on\s+)?\d{4}-\d{2}-\d{2}\b/gi,
    /\b(?:on\s+)?\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/gi,
  ];
  for (const re of patterns) for (const m of message.matchAll(re)) matches.push({ index: m.index ?? 0, length: m[0].length, token: m[0] });
  matches.sort((a, b) => a.index - b.index);
  const deduped = matches.filter((m, i) => i === 0 || m.index >= matches[i - 1].index + matches[i - 1].length);
  if (!deduped.length) return [{ text: message.trim(), reference: null }];
  const out: Array<{ text: string; reference: string | null }> = [];
  let start = 0; let currentReference: string | null = null;
  for (const hit of deduped) { const before = message.slice(start, hit.index).trim(); if (before) out.push({ text: before, reference: currentReference }); currentReference = hit.token; start = hit.index + hit.length; }
  const tail = message.slice(start).trim(); if (tail) out.push({ text: tail, reference: currentReference });
  return out.filter(x => x.text.length > 0);
}
export function attributeMultiDayReport(message: string, now = new Date()): MultiDayAttribution {
  const segments = splitAttributionReferences(String(message || "").trim());
  const beats: AttributedBeat[] = segments.map(segment => {
    if (!segment.reference) return { text: segment.text, dayKey: null, confidence: "ambiguous", dayReference: null };
    const resolved = resolveAttributionReference(segment.reference, now);
    return { text: segment.text, dayKey: resolved.dayKey, confidence: resolved.confidence, dayReference: segment.reference };
  });
  const distinctDays = new Set(beats.map(b => b.dayKey).filter(Boolean));
  return { beats, ambiguous: beats.some(b => b.dayKey == null || b.confidence === "ambiguous"), hasMultipleDays: distinctDays.size > 1 };
}
