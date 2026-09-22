import { sendWhatsApp } from "../../scheduler";
import { isProactivePaused } from "../shared";
import { logChat } from "../../handlers/chat-log";
import { fetchDueReminders, markReminderSent, nextRecurrenceTime, advanceRecurring, hasReturnedSince, isReturnKind } from "../../reminders";
import type { Recurrence } from "../../reminders";

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
      // EVIDENCE FIRST, AND THE ROW STAYS OPEN UNTIL WE ACT ON IT (C17).
      //
      // This closed the row before asking. `hasReturnedSince` is a database read, and a read can
      // fail transiently: the row was already marked `sent`, the surrounding catch logged, and the
      // client's nudge was gone for good with nothing left pending to retry. The order is now
      // check → decide → close, so a failed check leaves the reminder exactly as it was.
      //
      // DO NOT CHASE SOMETHING THEY HAVE ALREADY DONE. A return nudge says "Tomorrow you're back!
      // … nothing reset, your plan's exactly where you left it." To a client who came back early
      // and has been logging since, that is the coach asking for a commitment they already kept,
      // in the restart language the reactive door is not allowed to use. The one canceller could
      // not reach them: cancelReturnNudges is called from sick-flow.ts alone, behind a health
      // hold, so a holiday nudge can never take that exit. `hasReturnedSince` owns which evidence
      // counts for which reason — see its contract; this job only asks and obeys.
      if (isReturnKind((r as any).kind)
          && await hasReturnedSince(r.userId, new Date((r as any).createdAt), (r as any).kind)) {
        await markReminderSent(r.id);   // retired, not left to fire again tomorrow
        console.log(`[SCHEDULER] return nudge ${r.id} retired — client already came back`);
        continue;
      }
      // Advance/close BEFORE the send so a mid-send crash cannot double-fire. A recurring reminder
      // rolls to its next occurrence (stays pending); a one-shot is marked sent.
      const rec = (r as any).recurrence as Recurrence;
      if (rec) await advanceRecurring(r.id, nextRecurrenceTime(new Date(r.fireAt as any), rec));
      else await markReminderSent(r.id);
      const msg = isReturnKind((r as any).kind) ? r.body : `⏰ Reminder: ${r.body}`;
      await sendWhatsApp(r.phoneNumber, msg);
      await logChat(r.userId, "[reminder]", msg, isReturnKind((r as any).kind) ? "RETURN_NUDGE_FIRED" : "REMINDER_FIRED");
    } catch (err) {
      console.error(`[SCHEDULER] reminder ${r.id} send failed:`, err);
    }
  }
}
