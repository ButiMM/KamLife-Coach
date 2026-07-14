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

export type QualitySignalKind =
  | "never_silent"        // reply was empty → guaranteed fallback fired
  | "brain_defer"         // the model gave up / verifier failed twice → deterministic fallback
  | "verifier_violation"  // reply contradicted stored truth and was corrected/blocked
  | "media_unreadable"    // a photo/video couldn't be processed → fallback ask
  | "low_confidence";     // a handler served but flagged its own uncertainty

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
