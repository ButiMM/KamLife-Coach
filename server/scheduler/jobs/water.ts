import {
  db, chatHistory,
  eq, gte, and,
  sendWhatsApp, canSendRoutineNudge, recordProactiveSend, claimDailySlot,
  getActiveClients, isPaused, dayStart,
} from "../shared";
import { logChat } from "../../handlers/chat-log";

const WATER_NUDGES = [
  (name: string) => `${name}, have you had water today? Your body is already working — don't let dehydration slow your results. Aim for 2L before tonight. Log it: "drank 500ml".`,
  (name: string) => `${name} — quick check: water? Dehydration kills energy and makes hunger worse. Two litres today. Log it when you've had a glass.`,
  (name: string) => `Hydration check, ${name}. If you haven't had 1L yet today, drink a glass right now. Fat loss and muscle recovery both need water — this is non-negotiable.`,
  (name: string) => `${name}, midday water reminder. If you've been going on coffee and not much else — drink 500ml now. Your steps and workout performance drop 5–8% when dehydrated.`,
  (name: string) => `Water, ${name}. It sounds basic because it is — and most people don't do it. 2L today. Log it so I can track it.`,
];

export async function runWaterReminder(): Promise<void> {
  console.log("[SCHEDULER] JOB: Water reminder");
  const clients = await getActiveClients();
  const todayStart = dayStart(0);
  const idx = Math.floor(Date.now() / 86_400_000) % WATER_NUDGES.length;

  for (const client of clients) {
    if (isPaused(client)) continue;

    // Routine hydration nudge — eases off as the client goes quiet (anti-mute + cost).
    // canSendRoutineNudge also enforces the 1/day cap and the global pause.
    if (!canSendRoutineNudge(client)) continue;

    try {
      // Only nudge if they haven't logged water today already
      const [waterToday] = await db.select({ id: chatHistory.id })
        .from(chatHistory)
        .where(and(
          eq(chatHistory.userId, client.id),
          eq(chatHistory.intent, "WATER_LOG"),
          gte(chatHistory.createdAt, todayStart),
        ))
        .limit(1);

      if (waterToday) continue; // Already logged — skip

      // Atomic daily-slot claim before send — DB-backed, restart-safe. The back-off
      // prefilter above (canSendRoutineNudge) still eases off for quiet clients.
      if (await claimDailySlot(client.id, "water_reminder")) {
        const name = client.name?.split(" ")[0] || "there";
        const nudge = WATER_NUDGES[idx](name);
        await sendWhatsApp(client.phoneNumber, nudge);
        await logChat(client.id, "[auto]", nudge, "WATER_REMINDER");
      }
    } catch (err) {
      console.error(`[SCHEDULER] Water reminder error — ${client.phoneNumber}:`, err);
    }
  }
}
