import {
  db, eq, and, getActiveClients, isPaused, escalations,
} from "../shared";

/**
 * RETENTION RECORDS. IT DOES NOT SPEAK.
 *
 * (2026-08-19, Cut 6.) This file used to hold three of the five voices that could talk to a
 * client who had gone quiet: a 2-day note, a 7-day note, a 14-day note, plus a 30-day sign-off
 * next door and a Tue/Thu fan-out below. Silence now has one owner — the ladder in one-action.ts,
 * reached from runMorningCheckin, one rung per absence.
 *
 * A second job that still SENT would not be a smaller raffle, it would be the same clock bug:
 * DAILY_PROACTIVE_CAP is 1, morning runs at 04:00 UTC and this ran at 04:04, so which of them
 * reached the client was decided by four minutes. Worse in the gaps — the ladder claims a rung
 * once per absence, so on the days between rungs the budget was free and these notes went out
 * *instead of nothing*, undoing the cadence that makes the ladder humane.
 *
 * What remains is the one thing the ladder cannot do: TELL A HUMAN. Two weeks of silence is a
 * business event, not a coaching one, and the founder needs it in the escalation queue whether
 * or not a message went out that morning.
 *
 * ACCOUNTING FOR WHAT WAS REMOVED, as required before any send is deleted:
 *
 *   2-day note     → the client is not gone at two days; they get the ordinary morning brief,
 *                    which is what the daily budget was already giving them. Measured: morning
 *                    claimed the slot at 04:00 and this was suppressed at 04:04 every time.
 *   7-day note     → the ladder's week-1 rung, which asks for one meal instead of a workout.
 *   14-day note    → the ladder's week-2 rung. The ESCALATION it carried is kept below, and is
 *                    no longer gated behind a send budget — the old code created it inside
 *                    `if (ok)`, so once the ladder consumed the day's slot the founder would
 *                    have stopped being told. That is the defect this rewrite exists to prevent.
 *   30-day sign-off→ the ladder's month-plus rung says the same thing ("just say hi", nothing is
 *                    lost) and then goes quiet by construction, because every rung is claimed
 *                    once per absence. The behaviour the sign-off announced is preserved; the
 *                    announcement is not. Flagged explicitly rather than dropped silently.
 */
export async function runSilenceDetection(): Promise<void> {
  console.log("[SCHEDULER] JOB: Silence detection (record only)");
  const clients = await getActiveClients();
  const now = Date.now();
  const DAY = 86_400_000;

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      if (!client.lastActiveAt) continue;
      const silentDays = (now - new Date(client.lastActiveAt).getTime()) / DAY;
      if (silentDays < 14) continue;

      // Idempotent on its own terms, deliberately: one OPEN escalation per client is the
      // question a human actually answers, and it survives a redeploy without a claim row.
      const open = await db.select({ id: escalations.id }).from(escalations)
        .where(and(eq(escalations.userId, client.id), eq(escalations.status, "open"))).limit(1);
      if (open.length > 0) continue;

      await db.insert(escalations).values({
        userId: client.id, reason: "14_day_silence", status: "open",
        priority: "urgent", slaDeadline: new Date(now + 2 * DAY),
      });
      console.log(`[RETENTION] flagged ...${client.id.slice(-6)} — ${Math.floor(silentDays)}d silent, no message sent`);
    } catch (err) {
      console.error(`[SCHEDULER] Silence detection error — ${client.phoneNumber}:`, err);
    }
  }
}

/*
 * runDeepSilenceEscalation — REMOVED (2026-08-19, Cut 6). Its entire body was one send at 30
 * days: "I am not going to keep messaging you after this." It ran at 05:00 UTC, and by day 30
 * the ladder's month rung had been claimed two days earlier, so the daily budget was free and
 * this DID reach the client — the one place in the sweep where a second mouth genuinely won.
 * See the accounting in the comment above: the ladder makes the promise true instead of saying it.
 */

/*
 * runComebackMessages — REMOVED (2026-08-19, Cut 6).
 *
 * Four rotating templates for a client silent 3–7 days, on Tuesdays and Thursdays, picked by
 * `sent % 4` — that is, by this client's POSITION IN THE LOOP. Two clients in identical states
 * got different messages because of the order the database returned them.
 *
 * Every one of the four asked for TRAINING ("What time are you training?", "Reply *menu* to see
 * today's workout", "Reply *done* after your next workout") from someone who has not opened the
 * app in most of a week. The ladder asks such a client for ONE MEAL, and asks for less the longer
 * they have been gone.
 */
