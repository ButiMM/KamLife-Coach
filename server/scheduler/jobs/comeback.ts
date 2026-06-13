/**
 * Comeback Protocol — a structured 7-day return arc for clients who lapsed
 * and then signalled they're back (via the morning re-engagement buttons in
 * jobs/morning.ts → handled in handlers/lifecycle.ts).
 *
 * The old flow gave a returning client ONE reply, then went quiet until normal
 * check-ins resumed — so a fragile "I'm back" often fizzled within days. This
 * job turns that single moment into a guided arc:
 *
 *   Day 0  (reactive)   — "you're back, send me one meal"   [lifecycle.ts]
 *   Day 2  (this job)    — confirm the tiny win + protein focus
 *   Day 4  (this job)    — the one-session challenge (body, not just food)
 *   Day 7  (this job)    — graduation back to the full programme
 *
 * State lives in users.profileNotes as `comeback:YYYY-MM-DD` (the entry date),
 * mirroring the existing streak_shield:/paused_until: flag pattern. The flag is
 * cleared on graduation, or early if the client goes silent again (in which case
 * the normal silence-detection flow takes back over).
 *
 * Runs once daily at 5pm SAST — a separate "afternoon coach check-in" beat from
 * the 6am morning message, so it reads as intentional, not spam. Each milestone
 * is claimed once per entry-date, so a container recycle can't double-send.
 */

import {
  db, users, workoutLogs, chatHistory,
  eq, gte, and, count,
  sendWhatsApp, canSendProactive, claimProactive,
  getActiveClients, isPaused, isProactivePaused,
} from "../shared";

const COMEBACK_RE = /comeback:(\d{4}-\d{2}-\d{2})/;

function stripComebackFlag(notes: string | null | undefined): string {
  return (notes || "").replace(/\s*comeback:\d{4}-\d{2}-\d{2}/, "").trim();
}

export async function runComebackProtocol(): Promise<void> {
  console.log("[SCHEDULER] JOB: Comeback protocol");
  if (isProactivePaused()) { console.log("[SCHEDULER:PAUSED] runComebackProtocol blocked"); return; }
  const clients = await getActiveClients();
  let nudged = 0, graduated = 0, cleared = 0;

  for (const client of clients) {
    if (isPaused(client)) continue;
    const entryStr = (client.profileNotes || "").match(COMEBACK_RE)?.[1];
    if (!entryStr) continue;

    try {
      // SAST midnight of the entry date → UTC instant
      const entryDate = new Date(`${entryStr}T00:00:00+02:00`);
      const daysIn = Math.floor((Date.now() - entryDate.getTime()) / 86_400_000);
      const name = (client.name || "there").split(" ")[0];
      const daysSilent = client.lastActiveAt
        ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
        : 999;

      // ── Graduation (day 7+) ───────────────────────────────────────────────
      if (daysIn >= 7) {
        if (daysSilent <= 2 && await claimProactive(client.id, "comeback_graduate", entryStr)) {
          const [s] = await db.select({ c: count() }).from(workoutLogs)
            .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, entryDate)));
          const sessions = s?.c || 0;
          const sessionLine = sessions > 0
            ? `${sessions} session${sessions !== 1 ? "s" : ""} logged since you came back — `
            : "";
          await sendWhatsApp(client.phoneNumber,
            `${name}, a full week back. ${sessionLine}you didn't just return, you stayed. That's the part most people never do.\n\nThe comeback is over — you're back on the full programme now, same standards as everyone else. No easing off. Let's build.`);
          graduated++;
        }
        await db.update(users).set({ profileNotes: stripComebackFlag(client.profileNotes) || null }).where(eq(users.id, client.id));
        continue;
      }

      // ── Lapsed again mid-protocol — hand back to silence detection ─────────
      if (daysSilent >= 4) {
        await db.update(users).set({ profileNotes: stripComebackFlag(client.profileNotes) || null }).where(eq(users.id, client.id));
        cleared++;
        continue;
      }

      if (!canSendProactive(client.id)) continue;

      // ── Day 4+ — the one-session challenge ────────────────────────────────
      if (daysIn >= 4) {
        if (!await claimProactive(client.id, "comeback_d4", entryStr)) continue;
        const [s] = await db.select({ c: count() }).from(workoutLogs)
          .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, entryDate)));
        const trained = (s?.c || 0) > 0;
        await sendWhatsApp(client.phoneNumber, trained
          ? `${name}, four days back and you've already trained. You're not easing in — you're back. Keep the foot down: one more session before the weekend.`
          : `${name}, four days back. Food's handled — now the body.\n\nToday is the session. Not a perfect one. Reply *1* and I'll send a short workout — 20 minutes, home or gym. You already did the hard part by coming back. This is the easy part.`);
        nudged++;
        continue;
      }

      // ── Day 2+ — confirm the tiny win + protein focus ─────────────────────
      if (daysIn >= 2) {
        if (!await claimProactive(client.id, "comeback_d2", entryStr)) continue;
        const [f] = await db.select({ c: count() }).from(chatHistory)
          .where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, entryDate)));
        const logged = (f?.c || 0) > 0;
        await sendWhatsApp(client.phoneNumber, logged
          ? `${name}, two days back and you're logging again. That's the comeback working — momentum beats motivation every time.\n\nToday, one upgrade: protein at every meal. Eggs, chicken, pilchards, beans. That single thing moves the needle more than anything else. What's for breakfast?`
          : `${name}, you said you're back — but I haven't seen a meal yet. No stress, no lecture. The comeback isn't a grand gesture, it's one small log.\n\nSend me what you're eating right now. One line. That's the whole task today.`);
        nudged++;
        continue;
      }
      // Days 0,1,3,5,6 — intentional silence between beats; no message
    } catch (err) {
      console.error(`[SCHEDULER] Comeback protocol error — ${client.phoneNumber}:`, err);
    }
  }
  console.log(`[SCHEDULER] Comeback protocol — nudged:${nudged} graduated:${graduated} cleared:${cleared}`);
}
