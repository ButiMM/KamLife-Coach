import { sendWhatsApp } from "../../scheduler";
import { isProactivePaused } from "../shared";
import { logChat } from "../../handlers/chat-log";
import { fetchDueReminders, markReminderSent } from "../../reminders";

/**
 * FIRE DUE REMINDERS — polls every minute. Sends every pending reminder whose fireAt has
 * passed, then marks it 'sent'. These are EXPLICITLY user-requested, so they aren't gated
 * by per-client coaching pauses — only the global emergency killswitch (PROACTIVE_PAUSED)
 * holds them, and they stay 'pending' so they fire the moment the pause lifts.
 */
export async function runDueReminders(): Promise<void> {
  if (isProactivePaused()) { console.log("[SCHEDULER:PAUSED] runDueReminders held"); return; }
  let due;
  try {
    due = await fetchDueReminders(new Date());
  } catch (err) {
    console.error("[SCHEDULER] fetchDueReminders failed:", err);
    return;
  }
  if (!due.length) return;
  console.log(`[SCHEDULER] JOB: firing ${due.length} due reminder(s)`);
  for (const r of due) {
    try {
      // Mark sent FIRST so a mid-send crash can't double-fire the same reminder.
      await markReminderSent(r.id);
      // Client-set reminders get the ⏰ prefix; auto 'return' nudges are self-contained coach talk.
      const msg = (r as any).kind === "return" ? r.body : `⏰ Reminder: ${r.body}`;
      await sendWhatsApp(r.phoneNumber, msg);
      await logChat(r.userId, "[reminder]", msg, (r as any).kind === "return" ? "RETURN_NUDGE_FIRED" : "REMINDER_FIRED");
    } catch (err) {
      console.error(`[SCHEDULER] reminder ${r.id} send failed:`, err);
    }
  }
}
