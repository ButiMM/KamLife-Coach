/**
 * MALFORMED-OUTPUT GUARD — the cheap mitigation for the two-engine problem (ledger D6).
 *
 * (2026-07-28, from a third-party review: "You do not have time for a full migration before the
 * cohort. You have time for a guard.") That is the right call. The old brain occasionally emits
 * text that is not wrong so much as BROKEN — a literal asterisk, an unclosed bracket, a sentence
 * that stops mid-word, "3 meals (breakfast and lunch)". On WhatsApp a client cannot refresh the
 * page; one of those and the coach looks like a machine having a stroke.
 *
 * A migration is weeks and risks the food logging that currently works. This is minutes and
 * protects the client today. It does not fix the old brain — it stops its worst output reaching
 * a human, and logs every catch so the real fix has evidence to work from.
 *
 * Deliberately narrow. Every check below fires on something structurally impossible in a correct
 * reply, never on style. A guard that rejects good replies would be worse than the bug.
 *
 * Pure — no DB, no model. Unit-tested.
 */

export interface GuardResult {
  pass: boolean;
  /** Which checks failed, for the log. Empty when it passed. */
  reasons: string[];
}

/** WhatsApp bold is *one* asterisk each side; an ODD count means one is showing as a literal. */
function balancedAsterisks(s: string): boolean {
  return ((s.match(/\*/g) || []).length % 2) === 0;
}

function balanced(s: string, open: string, close: string): boolean {
  return (s.split(open).length - 1) === (s.split(close).length - 1);
}

/** "3 meals (breakfast and lunch)" — the count and the list disagree. */
const COUNT_MISMATCH = /\b(\d+)\s+(meals?|sessions?|days?|exercises?)\s*\(([^)]*)\)/i;

function countMatchesList(s: string): boolean {
  const m = COUNT_MISMATCH.exec(s);
  if (!m) return true;
  const claimed = parseInt(m[1], 10);
  if (!Number.isFinite(claimed)) return true;
  const listed = m[3].split(/\s*(?:,|\band\b)\s*/).filter(x => x.trim().length > 1).length;
  return listed === 0 || listed === claimed;
}

/** Ends mid-word or on a dangling connective — the model was cut off. */
const TRUNCATED = /(?:\b(?:and|or|but|with|the|a|to|for|of|is|are|your|you|because|so|then)\s*|[,;:—-]\s*|\w{2,}\.\.\.)$/i;

/** A template slot that never got filled. Distinct from the outbound leak gate, which is broader. */
const UNRENDERED = /\$\{|\{\{|\bundefined\b|\bNaN\b|\[object Object\]/;

/**
 * Is this reply structurally safe to send? Only catches breakage, never tone.
 * `maxLines` is generous on purpose — the reply contract owns length; this owns integrity.
 */
export function guardMalformed(reply: string, maxLines = 14): GuardResult {
  const s = (reply || "").trim();
  const reasons: string[] = [];

  if (!s) reasons.push("empty");
  if (!balancedAsterisks(s)) reasons.push("literal_asterisk");
  if (!balanced(s, "(", ")")) reasons.push("unclosed_parens");
  if (!balanced(s, "[", "]")) reasons.push("unclosed_brackets");
  if (!countMatchesList(s)) reasons.push("count_mismatch");
  if (s && TRUNCATED.test(s)) reasons.push("truncated");
  if (UNRENDERED.test(s)) reasons.push("unrendered_template");
  if (s.split("\n").length > maxLines) reasons.push("too_long");

  return { pass: reasons.length === 0, reasons };
}

/**
 * What to send instead. Boring but never wrong — and it must never pretend the coach said
 * something it did not, so it asks rather than invents.
 */
export function safeFallback(firstName = ""): string {
  const fn = firstName ? `${firstName}, ` : "";
  return `${fn}that came out garbled on my side — my fault, not yours.\n\nSay it again in one line and I'll answer it properly.`;
}

// ── OBSERVABILITY (2026-07-28, from review: "If the guard triggers silently or logs generically,
// it is rot. If every trigger fires a specific alert with the input/output pair, it is
// instrumented debt.") A guard nobody counts is a guard nobody removes.
//
// The threshold is the reviewer's, and it is a commitment: if this fires on more than 5% of
// model replies in the first week of the cohort, finishing the engine migration becomes
// priority #1 over any new feature.
export const GUARD_ESCALATION_THRESHOLD = 0.05;

let _checked = 0;
let _blocked = 0;

/** Record one guard decision. Called by the reply path; cheap and in-memory. */
export function recordGuardResult(passed: boolean): void {
  _checked++;
  if (!passed) _blocked++;
}

export interface GuardStats { checked: number; blocked: number; rate: number; escalate: boolean }

/** Current guard health. `escalate` true = stop adding features, finish the migration. */
export function guardStats(): GuardStats {
  const rate = _checked > 0 ? _blocked / _checked : 0;
  return { checked: _checked, blocked: _blocked, rate, escalate: _checked >= 100 && rate > GUARD_ESCALATION_THRESHOLD };
}

/** One line for the founder-facing report. */
export function guardStatsLine(): string {
  const s = guardStats();
  if (s.checked === 0) return "🧱 *Old-engine guard:* nothing checked yet.";
  const pct = (s.rate * 100).toFixed(1);
  return s.escalate
    ? `🧱 *Old-engine guard:* blocked *${s.blocked}* of ${s.checked} replies (*${pct}%*).\n\n🚨 Past the ${GUARD_ESCALATION_THRESHOLD * 100}% line — finishing the engine migration is now priority #1 over new features.`
    : `🧱 *Old-engine guard:* blocked *${s.blocked}* of ${s.checked} replies (${pct}%). Under the ${GUARD_ESCALATION_THRESHOLD * 100}% escalation line.`;
}
