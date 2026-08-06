// Monetization config (2026-07-14, founder directive: "I hate trials — people churn
// by the 7th/14th day"). PAY-TO-START by default: no free-access window. A new member
// gets the full onboarding conversation + their personalised Day-1 programme as the
// taste, then pays to continue — backed by a money-back guarantee (risk reversal
// WITHOUT giving the product away for a week and filtering for committed members).
//
// TRIAL_DAYS>0 reinstates a free trial of that many days — one env change, instantly
// reversible if the funnel needs it. Existing trial members are grandfathered (the
// gate respects their betaBypassUntil); only NEW signups are affected.
export const TRIAL_DAYS = Math.max(0, Math.floor(Number(process.env.TRIAL_DAYS ?? 0)));
export const TRIALS_ENABLED = TRIAL_DAYS > 0;

/* ────────────────────────────────────────────────────────────────────────────
 * ONE TRIAL PER NUMBER, EVER (2026-08-06, founder directive).
 *
 * The abuse loop is start → cancel → start → cancel. Two thirds of it were already
 * closed and it is worth being precise about which third was not:
 *
 *   • Cancelling and coming back does NOT re-grant a trial. Cancel sets the status to
 *     inactive and KEEPS the row, and the trial grant in completeOnboarding fires only
 *     when betaBypassUntil is null. A returning member hits the paywall. Already true.
 *   • The subscription gate in routes.ts already refuses to coach an inactive number at
 *     all, safety messages excepted. Already true.
 *   • But *delete my data* DELETES THE USER ROW and inserts a fresh one with a null
 *     betaBypassUntil — so a client can reset their own trial with a documented POPIA
 *     command, which is the loop from the reel, reachable in two messages.
 *
 * So the record has to outlive the account. It is a salted one-way hash of the number and
 * nothing else: it can answer "has this number trialed?" and it cannot be turned back into
 * a contact list, which is what makes keeping it defensible after a deletion request.
 *
 * DELIBERATELY NOT BUILT: velocity scoring, device fingerprinting, an event log, a fraud
 * engine. At this scale the founder's own eyes are a better instrument, and every one of
 * those is a system to maintain for abuse that has not happened yet.
 * ──────────────────────────────────────────────────────────────────────────── */

import { createHash } from "node:crypto";
import { normaliseMsisdn } from "./utils";

/**
 * Salted SHA-256 of the normalised number. The salt is server-side so that even with the
 * table in hand, nobody can test a list of South African numbers against it.
 *
 * TRIAL_HASH_SALT should be set in Railway. If it is not, the hash still works and still
 * enforces the rule — it is just guessable by someone who already has the database, which
 * is a strictly smaller problem than storing the numbers in plain text.
 */
export function trialHash(phone: string): string {
  const msisdn = normaliseMsisdn(phone);
  if (!msisdn) return "";
  return createHash("sha256")
    .update(`${process.env.TRIAL_HASH_SALT || "kamlife-trial-v1"}:${msisdn}`)
    .digest("hex");
}

/**
 * Has this number ever been granted a free trial?
 *
 * FAIL-CLOSED, and this is the one place in the codebase that is. Everything else here
 * fails open because a broken gate that eats a message is worse than the bug it prevents.
 * Not this: if the lookup throws we cannot prove the number is new, and the safe answer to
 * "may I give this stranger the product for free?" is no. They still get the full onboarding
 * and the Day-1 programme; they just get the paywall instead of a free week, which is the
 * default behaviour today anyway (TRIAL_DAYS=0).
 *
 * The db import is dynamic on purpose: pricing-config is imported by pure unit tests, and a
 * top-level db import would drag a live connection into them.
 */
export async function hasTrialedBefore(phone: string): Promise<boolean> {
  const hash = trialHash(phone);
  if (!hash) return true; // unreadable number → do not hand out a trial
  try {
    const { db } = await import("./db");
    const { trialedNumbers } = await import("../shared/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select({ h: trialedNumbers.phoneHash })
      .from(trialedNumbers).where(eq(trialedNumbers.phoneHash, hash)).limit(1);
    return rows.length > 0;
  } catch (e) {
    console.error("[TRIAL_GUARD] lookup failed — refusing the trial (fail-closed):", (e as Error)?.message);
    return true;
  }
}

/**
 * Remember that this number has now had its one trial. Idempotent — a repeat is a no-op,
 * because the first date is the one that matters and overwriting it would let a loop keep
 * the record looking fresh.
 */
export async function recordTrialGranted(phone: string): Promise<void> {
  const hash = trialHash(phone);
  if (!hash) return;
  try {
    const { db } = await import("./db");
    const { trialedNumbers } = await import("../shared/schema");
    await db.insert(trialedNumbers).values({ phoneHash: hash }).onConflictDoNothing();
  } catch (e) {
    // Non-fatal for THIS signup, but it means the next one could get a second trial —
    // loud on purpose so it shows up in the logs rather than silently weakening the rule.
    console.error("[TRIAL_GUARD] could not record the trial grant:", (e as Error)?.message);
  }
}

/**
 * SIGNUP VELOCITY — FLAG, NEVER BLOCK (2026-08-06 founder directive item 5: "several signups
 * in a short window → review manually. At 10 to hundreds of users, your own eyes are enough.")
 *
 * So this blocks nothing and scores nobody. It counts completed signups in the last hour and,
 * past a threshold a real launch day would also cross, sends the founder ONE message. He looks.
 * That is the entire feature, and at this scale it is a better instrument than a fraud engine
 * — it cannot false-positive a real client out of the product, which is the failure mode that
 * actually costs money here.
 *
 * Rate-limited to one alert per hour so a genuine rush (a post going out, a referral chain)
 * reports itself once instead of buzzing his phone forty times.
 *
 * Fail-silent: this is an observability nicety, and it must never be able to break a signup.
 */
const VELOCITY_WINDOW_MS = 60 * 60_000;
const VELOCITY_THRESHOLD = 5;

export async function flagSignupVelocity(): Promise<void> {
  try {
    const { db } = await import("./db");
    const { users } = await import("../shared/schema");
    const { gte, and, eq } = await import("drizzle-orm");
    const { sendCriticalAlert, loadState, saveState } = await import("./scheduler/shared");

    const coachPhone = process.env.COACH_ALERT_PHONE;
    if (!coachPhone) return;

    const since = new Date(Date.now() - VELOCITY_WINDOW_MS);
    const recent = await db.select({ id: users.id }).from(users)
      .where(and(gte(users.createdAt, since), eq(users.onboardingState, "COMPLETE")));
    if (recent.length < VELOCITY_THRESHOLD) return;

    const hourKey = new Date().toISOString().slice(0, 13); // one alert per clock hour
    if (loadState()["signup_velocity_alert"] === hourKey) return;
    saveState("signup_velocity_alert", hourKey);

    await sendCriticalAlert(
      `whatsapp:+${coachPhone.replace(/\D/g, "")}`,
      `[SIGNUPS] ${recent.length} signups completed in the last hour. Nothing has been blocked — worth a look at the Beta Testers page if you weren't expecting a rush.`,
    );
  } catch (e) {
    console.warn("[SIGNUP_VELOCITY] non-fatal:", (e as Error)?.message);
  }
}
