/**
 * Trial conversion sequence — fires at Day 2, Day 5, and Day 7 of a free trial.
 *
 * betaBypassUntil is set to now + 7 days when the trial is granted.
 * So: trialStart = betaBypassUntil - 7 days.
 *
 * Day 2: "Here's what you've unlocked" — early value proof, reduce buyer's remorse.
 * Day 5: "3 days left" — urgency + value recap + easy payment link.
 * Day 7: "Trial ends today" — final conversion push, objection-handling tone.
 *
 * All sends use claimProactive with a unique dedupeWindow so they fire exactly once
 * per trial, even if the job runs multiple times or the container recycles mid-day.
 */

import {
  db, users, eq, and, gte, lt,
  sendWhatsApp, claimProactive, getActiveClients, isPaused,
  todaySAST, isProactivePaused,
} from "../shared";

function trialDaysIn(betaBypassUntil: Date | null | undefined): number | null {
  if (!betaBypassUntil) return null;
  const trialStart = new Date(betaBypassUntil).getTime() - 7 * 86_400_000;
  return Math.floor((Date.now() - trialStart) / 86_400_000);
}

export async function runTrialCountdown(): Promise<void> {
  console.log("[SCHEDULER] JOB: Trial countdown");
  if (isProactivePaused()) return;

  const appUrl = process.env.APP_URL || "";
  const merchantId = process.env.PAYFAST_MERCHANT_ID;

  const trialUsers = await db.select().from(users).where(
    and(
      eq(users.subscriptionStatus, "trial"),
      // Only users who actually have a betaBypassUntil set (real trial users)
      gte(users.betaBypassUntil, new Date()),
    )
  );

  for (const user of trialUsers) {
    if (isPaused(user)) continue;
    try {
      const daysIn = trialDaysIn(user.betaBypassUntil);
      if (daysIn === null) continue;

      const name = user.name?.split(" ")[0] || "there";
      const cleanPhone = user.phoneNumber.replace(/^whatsapp:/, "");
      const payLink = merchantId && appUrl
        ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}`
        : appUrl;
      const goal = user.goalType === "muscle_gain" ? "muscle" : user.goalType === "recomposition" ? "recomp" : "fat loss";
      const workouts = user.totalWorkoutsCompleted || 0;

      if (daysIn === 2) {
        // Day 2: value proof — what they've already unlocked
        if (await claimProactive(user.id, "trial_day2", todaySAST())) {
          const msg = `${name}, Day 2 of your trial.\n\n`
            + `Here is what you have unlocked so far:\n`
            + `✅ Personalised ${goal} programme\n`
            + `✅ Daily calorie and protein coaching\n`
            + `✅ Real SA food database — pap, braai, pilchards, all of it\n`
            + (workouts > 0 ? `✅ ${workouts} session${workouts === 1 ? "" : "s"} already logged\n` : "")
            + `✅ Morning and evening check-ins\n\n`
            + `Your trial runs 5 more days. When you are ready to continue:\n${payLink || "Reply *pay* for your link."}`;
          await sendWhatsApp(user.phoneNumber, msg);
        }
      } else if (daysIn === 5) {
        // Day 5: urgency nudge — 3 days left
        if (await claimProactive(user.id, "trial_day5", todaySAST())) {
          const msg = `${name}, *3 days left on your trial.*\n\n`
            + `You are ${workouts > 0 ? `${workouts} session${workouts === 1 ? "" : "s"} in` : "getting started"} — do not let the momentum stop here.\n\n`
            + `R199/month. R6.63/day. Less than a cooldrink. Cancel anytime.\n\n`
            + `Tap to continue coaching:\n${payLink || "Reply *pay* for your link."}`;
          await sendWhatsApp(user.phoneNumber, msg);
        }
      } else if (daysIn >= 7) {
        // Day 7+: final push — trial ends today (or is past, use betaBypassUntil for timing)
        const bypassDate = user.betaBypassUntil ? new Date(user.betaBypassUntil) : null;
        const trialEndsToday = bypassDate
          ? bypassDate.toISOString().slice(0, 10) === todaySAST()
          : daysIn === 7;
        if (trialEndsToday && await claimProactive(user.id, "trial_day7", todaySAST())) {
          const msg = `${name}, your trial ends *today.*\n\n`
            + `Everything you have built — your programme, your logs, your ${workouts} session${workouts === 1 ? "" : "s"} — is saved. Nothing is lost.\n\n`
            + `To keep coaching going, tap here now:\n${payLink || "Reply *pay* for your link."}\n\n`
            + `R199/month — cancel anytime. If you have questions about the price or are not sure, just reply and I will sort it out.`;
          await sendWhatsApp(user.phoneNumber, msg);
        }
      }
    } catch (err) {
      console.error(`[SCHEDULER] Trial countdown error — user ${user.id.slice(-6)}:`, err);
    }
  }
}
