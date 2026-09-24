// Monetization config. PAY-TO-START (2026-07-14, founder: "I hate trials"): no free-access
// window. The trial switch, its one-trial-per-number guard and its countdown were deleted with
// #275 — they could only ever run with TRIAL_DAYS>0, and the offer has no trial.

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
