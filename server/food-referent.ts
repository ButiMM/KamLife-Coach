/**
 * PENDING FOOD REFERENT — pure, unit-tested.
 *
 * (2026-07-23 live) The "Can I eat this?" verdict ends with "Reply *log it* and I'll count
 * it" — but NOTHING was stored, and no handler understood "log it". The client wrote
 * "I just had 3 handfuls of it" and the bot said "I didn't catch what food that was" —
 * about the food IT had just analysed. The bot set up a pronoun and then forgot its own
 * referent.
 *
 * Cure: the verdict parks WHAT was discussed (name + per-serving kcal/protein) in
 * profileNotes; the next message that points back at it ("log it", "had 3 handfuls of it",
 * "ate half of it") resolves against the parked food and logs a multiple of the serving.
 * Referent expires after 6h and is consumed on use — it can never double-log.
 */

const MARKER_RE = /\s*\|?\s*pending_food:[^|]*/g;

export interface PendingFood { name: string; kcal: number; protein: number; at: number }

// profileNotes is a pipe-delimited grab-bag (sick_until, back_on, …) — same pattern here.
// The name is sanitised so it can never break the pipe format.
export function encodePendingFood(notes: string | null | undefined, f: { name: string; kcal: number; protein: number; at?: number }): string {
  const base = (notes || "").replace(MARKER_RE, "").trim();
  const name = (f.name || "that food").replace(/[|:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const marker = `pending_food:${name};${Math.max(0, Math.round(f.kcal))};${Math.max(0, Math.round(f.protein))};${f.at ?? Date.now()}`;
  return base ? `${base} | ${marker}` : marker;
}

export function readPendingFood(notes: string | null | undefined, maxAgeMs = 6 * 3_600_000): PendingFood | null {
  const m = (notes || "").match(/pending_food:([^;|]+);(\d+);(\d+);(\d+)/);
  if (!m) return null;
  const at = parseInt(m[4], 10);
  if (!Number.isFinite(at) || Date.now() - at > maxAgeMs) return null;
  return { name: m[1].trim(), kcal: parseInt(m[2], 10) || 0, protein: parseInt(m[3], 10) || 0, at };
}

export function clearPendingFood(notes: string | null | undefined): string {
  return (notes || "").replace(MARKER_RE, "").trim().replace(/^\|\s*/, "").replace(/\s*\|$/, "");
}

// Does this message point back at the discussed food, and how much of it?
// Returns the serving multiple, or null if the message is about something else.
// STRICT by design: an anaphor (it/that/them/those) or a bare log-command is required,
// and a message naming a real different food should never land here (the caller runs the
// food scanner first; this is the fallback for messages with NO recognisable food).
export function parseReferentReply(message: string): { mult: number } | null {
  const m = (message || "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (!m || m.length > 80) return null;
  // Bare log-command — the exact thing the verdict asks for.
  if (/^(log it|log that|log this|logged it|yes log it|ok log it|count it|i ate it|ate it|had it|i had it|i ate that|had that)$/.test(m)) return { mult: 1 };
  // Quantity + unit + anaphor: "I just had 3 handfuls of it", "ate 2 servings of that",
  // "had half of it". Word-numbers and "half" normalised first.
  const norm = m
    .replace(/\bhalf\s+of\b/g, "0.5 of").replace(/\bhalf\b/g, "0.5")
    .replace(/\bone\b/g, "1").replace(/\btwo\b/g, "2").replace(/\bthree\b/g, "3")
    .replace(/\bfour\b/g, "4").replace(/\bfive\b/g, "5").replace(/\ba couple( of)?\b/g, "2");
  const qm = norm.match(/\b(\d+(?:\.\d+)?)\s*(?:handfuls?|servings?|portions?|bowls?|cups?|pieces?|packets?|plates?|scoops?|more)?\s*(?:of\s+)?(?:it|that|them|those|the same)\b/);
  if (qm) {
    const n = parseFloat(qm[1]);
    if (Number.isFinite(n) && n > 0 && n <= 20) return { mult: n };
  }
  // "some of it" / "a bit of it" — lean low, half a serving.
  if (/\b(?:some|a bit|a little)\s+(?:of\s+)?(?:it|that|them|those)\b/.test(norm)) return { mult: 0.5 };
  return null;
}
