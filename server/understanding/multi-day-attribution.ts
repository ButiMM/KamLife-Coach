/**
 * Multi-day attribution for messy human reports.
 *
 * This module answers exactly one question: which calendar day does each reported beat belong to?
 * It does not write, choose an action, or decide what the client should do.
 *
 * Product contract:
 * - one WhatsApp message may contain multiple days;
 * - explicit past/current day labels are attributable;
 * - future labels are not silently logged as past facts;
 * - an ambiguous day is represented as null, never guessed;
 * - when a day is explicitly named, the beat carries that day independently of other beats.
 */

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

const SAST = "Africa/Johannesburg";
const DAY_WORDS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function dateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SAST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function sastParts(date: Date): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SAST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || "";
  const weekdayName = get("weekday").toLowerCase();
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: DAY_WORDS[weekdayName] ?? 0,
  };
}

function shiftDays(date: Date, days: number): Date {
  const parts = sastParts(date);
  const noonUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
  noonUtc.setUTCDate(noonUtc.getUTCDate() + days);
  return noonUtc;
}

function resolveReference(token: string, now: Date): { dayKey: string | null; confidence: AttributedBeat["confidence"] } {
  const t = token.toLowerCase().trim();
  const today = now;

  if (/^(today|this morning|this afternoon|this evening|tonight)$/.test(t)) {
    return { dayKey: dateKey(today), confidence: "relative" };
  }
  if (/^(yesterday|last night)$/.test(t)) {
    return { dayKey: dateKey(shiftDays(today, -1)), confidence: "relative" };
  }

  const dayMatch = t.match(/^(this|last|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (dayMatch) {
    const mode = dayMatch[1];
    const target = DAY_WORDS[dayMatch[2]];
    const current = sastParts(today).weekday;
    let delta = (target - current + 7) % 7;
    if (mode === "last") {
      delta = delta === 0 ? -7 : delta - 7;
    } else if (mode === "this") {
      if (delta > 0) delta -= 7;
    } else {
      // Future intent is never a writable date. The caller must ask rather than log it.
      return { dayKey: null, confidence: "ambiguous" };
    }
    return { dayKey: dateKey(shiftDays(today, delta)), confidence: "explicit" };
  }

  const bareDay = t.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (bareDay) {
    const target = DAY_WORDS[bareDay[1]];
    const current = sastParts(today).weekday;
    let delta = (target - current + 7) % 7;
    if (delta > 0) delta -= 7;
    return { dayKey: dateKey(shiftDays(today, delta)), confidence: "explicit" };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const d = new Date(`${t}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? { dayKey: null, confidence: "ambiguous" } : { dayKey: t, confidence: "explicit" };
  }

  const dmy = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (dmy) {
    const year = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    const month = Number(dmy[2]);
    const day = Number(dmy[1]);
    const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(`${iso}T12:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? { dayKey: null, confidence: "ambiguous" } : { dayKey: iso, confidence: "explicit" };
  }

  return { dayKey: null, confidence: "ambiguous" };
}

function splitAtReferences(message: string): Array<{ text: string; reference: string | null }> {
  const matches: Array<{ index: number; length: number; token: string }> = [];
  const patterns = [
    /\b(?:today|this morning|this afternoon|this evening|tonight|yesterday|last night)\b/gi,
    /\b(?:this|last|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    /\b(?:on\s+)?\d{4}-\d{2}-\d{2}\b/gi,
    /\b(?:on\s+)?\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/gi,
  ];
  for (const re of patterns) {
    for (const m of message.matchAll(re)) matches.push({ index: m.index ?? 0, length: m[0].length, token: m[0] });
  }
  matches.sort((a, b) => a.index - b.index);
  const deduped = matches.filter((m, i) => i === 0 || m.index >= matches[i - 1].index + matches[i - 1].length);
  if (!deduped.length) return [{ text: message.trim(), reference: null }];

  const out: Array<{ text: string; reference: string | null }> = [];
  let start = 0;
  let currentReference: string | null = null;
  for (const hit of deduped) {
    const before = message.slice(start, hit.index).trim();
    if (before) out.push({ text: before, reference: currentReference });
    currentReference = hit.token;
    start = hit.index + hit.length;
  }
  const tail = message.slice(start).trim();
  if (tail) out.push({ text: tail, reference: currentReference });

  return out.filter(x => x.text.length > 0);
}

export function attributeMultiDayReport(message: string, now = new Date()): MultiDayAttribution {
  const segments = splitAtReferences(String(message || "").trim());
  const beats: AttributedBeat[] = segments.map(segment => {
    if (!segment.reference) {
      return { text: segment.text, dayKey: null, confidence: "ambiguous", dayReference: null };
    }
    const resolved = resolveReference(segment.reference, now);
    return { text: segment.text, dayKey: resolved.dayKey, confidence: resolved.confidence, dayReference: segment.reference };
  });

  const distinctDays = new Set(beats.map(b => b.dayKey).filter(Boolean));
  return {
    beats,
    ambiguous: beats.some(b => b.dayKey == null || b.confidence === "ambiguous"),
    hasMultipleDays: distinctDays.size > 1,
  };
}
