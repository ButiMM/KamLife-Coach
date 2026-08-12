/**
 * QUALITY SIGNALS — capture every moment the bot fumbles, so real use improves
 * the product automatically (2026-07-14, Kam: "we push the envelope for them —
 * do they push it back for us?").
 *
 * Before this, a bad moment (empty reply, brain defer, unreadable photo, a
 * verifier catch) was logged to console and evaporated — the only path to a fix
 * was the founder screenshotting it. Now each fumble lands in quality_signals:
 * a founder review queue AND candidate regression cases for the batteries.
 *
 * Contract: captureQualitySignal is FIRE-AND-FORGET. It never throws, never
 * blocks, and never delays a reply — a telemetry write must not be able to break
 * the very reply it is measuring. All inputs are truncated; only the last 4
 * phone digits are stored.
 */

import { db } from "./db";
import { qualitySignals } from "../shared/schema";
import { and, eq, gte, sql } from "drizzle-orm";

export type QualitySignalKind =
  | "never_silent"        // reply was empty → guaranteed fallback fired
  | "brain_defer"         // the model gave up / verifier failed twice → deterministic fallback
  | "verifier_violation"  // reply contradicted stored truth and was corrected/blocked
  | "media_unreadable"    // a photo/video couldn't be processed → fallback ask
  | "low_confidence"      // a handler served but flagged its own uncertainty
  | "shadow_review"       // shadow Meaning Engine scored low or tied vs production → human look
  | "daily_review"        // nightly self-audit graded a LIVE exchange weak → auto-filed for fixing
  // FRICTION kinds (see friction.ts) — a client fighting the bot, not a bot fumble. Stored in
  // the same table (no migration) but excluded from the north-star "fumbles" count so the two
  // signals don't conflate. Written via captureFriction, never captureQualitySignal directly.
  | "friction_correction"
  | "friction_rejection"
  | "friction_redirect"
  | "friction_frustration"
  // SYMPTOM kinds (2026-08-12) — a CLIENT-STATE observation, and neither a bot fumble nor
  // friction. See the note above captureSymptom for why the distinction is load-bearing.
  | "symptom_hunger";

const clip = (s: string | null | undefined, n = 500): string | null => {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export function captureQualitySignal(kind: QualitySignalKind, opts: {
  userId?: string | null;
  phone?: string | null;
  messageIn?: string | null;
  messageOut?: string | null;
  detail?: string | null;
}): void {
  try {
    const phoneLast4 = opts.phone ? opts.phone.replace(/\D/g, "").slice(-4) : null;
    // Fire-and-forget: awaiting this would let a telemetry hiccup delay the reply.
    void db.insert(qualitySignals).values({
      userId: opts.userId ?? null,
      phoneLast4,
      kind,
      messageIn: clip(opts.messageIn),
      messageOut: clip(opts.messageOut),
      detail: clip(opts.detail, 300),
    }).catch((e) => console.warn(`[QUALITY_SIGNAL] insert failed (${kind}):`, (e as Error)?.message));
  } catch (e) {
    // Never let capture break a reply.
    console.warn(`[QUALITY_SIGNAL] capture threw (${kind}):`, (e as Error)?.message);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * SYMPTOM PERSISTENCE — "I'm hungry" versus "I've been hungry every afternoon for six days".
 *
 * Those are not the same state, and today the product cannot tell them apart: hunger arrives as
 * an isolated message and is gone by the next turn. The hunger doctrine needs the second form —
 * a symptom is only worth investigating once it PERSISTS — so the occurrences have to be
 * recorded before any reasoning about them is possible.
 *
 * WHY NOT A FRICTION KIND. Friction means the client is FIGHTING THE BOT: it ranks the operator's
 * "needs attention" queue and its red flag reads "Read their chat; the bot is failing them". A
 * hungry client is not a bot failure — it is a legitimate coaching input, and filing it as
 * friction would put someone in the churn-risk queue for reporting a symptom we asked them to
 * report. So this reuses friction's PATTERN (same table, own namespace, own aggregation) and
 * pointedly not its KIND. frictionCountsLast7 filters on FRICTION_SIGNAL_KINDS explicitly, so
 * symptom rows cannot leak into it.
 *
 * IT RECORDS, IT DOES NOT DIAGNOSE. No cause, no advice, no "hunger means low protein" — that
 * conclusion belongs downstream, to Coach K, with the rest of the evidence in front of it.
 * ──────────────────────────────────────────────────────────────────────────── */

export type SymptomKind = "hunger";
export const symptomSignalKind = (k: SymptomKind): string => `symptom_${k}`;
export const SYMPTOM_SIGNAL_KINDS: string[] = (["hunger"] as SymptomKind[]).map(symptomSignalKind);

/**
 * A client-state observation is NOT a moment the bot fumbled. The admin review queue presents
 * every row as a fumble, so symptom kinds are excluded there — otherwise reporting hunger would
 * file the client as a product defect.
 */
export const NOT_A_BOT_FUMBLE: string[] = [...SYMPTOM_SIGNAL_KINDS];

/** Record one symptom report. Fire-and-forget, exactly like captureFriction — never blocks a reply. */
export function captureSymptom(kind: SymptomKind, opts: {
  userId?: string | null;
  phone?: string | null;
  messageIn?: string | null;
  detail?: string | null;
}): void {
  captureQualitySignal(symptomSignalKind(kind) as any, opts);
}

export interface SymptomPersistence {
  kind: SymptomKind;
  /** How many times it was reported in the window. */
  occurrences: number;
  /**
   * DISTINCT DAYS it was reported — the number that actually matters. Six messages in one bad
   * afternoon is one day of evidence, not six, and treating it as six is how a doctrine that
   * requires PERSISTENCE fires on a single rough evening.
   */
  distinctDays: number;
  firstAt: Date | null;
  lastAt: Date | null;
  windowDays: number;
}

/** Read-only. Returns the shape of the symptom over the window and nothing else. */
export async function symptomPersistence(
  userId: string, kind: SymptomKind, windowDays = 7,
): Promise<SymptomPersistence> {
  const empty: SymptomPersistence = { kind, occurrences: 0, distinctDays: 0, firstAt: null, lastAt: null, windowDays };
  if (!userId) return empty;
  try {
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const [row] = await db.select({
      n: sql<number>`COUNT(*)::int`,
      days: sql<number>`COUNT(DISTINCT DATE(${qualitySignals.createdAt}))::int`,
      first: sql<Date | null>`MIN(${qualitySignals.createdAt})`,
      last: sql<Date | null>`MAX(${qualitySignals.createdAt})`,
    }).from(qualitySignals).where(and(
      eq(qualitySignals.userId, userId),
      eq(qualitySignals.kind, symptomSignalKind(kind)),
      gte(qualitySignals.createdAt, since),
    ));
    if (!row) return empty;
    return {
      kind,
      occurrences: Number((row as any).n || 0),
      distinctDays: Number((row as any).days || 0),
      firstAt: (row as any).first ?? null,
      lastAt: (row as any).last ?? null,
      windowDays,
    };
  } catch (e) {
    // Telemetry must never break coaching. No evidence is an honest answer; a thrown error is not.
    console.warn("[SYMPTOM] persistence read failed:", (e as Error)?.message);
    return empty;
  }
}
