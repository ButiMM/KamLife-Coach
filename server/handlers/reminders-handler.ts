/**
 * REMINDER COMMAND — deterministic, reliable. Owns "remind me to X at Y", "my reminders",
 * "cancel reminders", and the two-step follow-ups when a time or a task is missing. A
 * reminder is a promise; the parser (server/reminders.ts) is deterministic so the promise
 * is kept. Runs BEFORE the keyword wall and the brain so nothing hijacks it.
 */

import { db } from "../db";
import { users } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { logChat } from "./chat-log";
import {
  parseReminderRequest, createReminder, listPendingReminders, cancelAllReminders,
  describeFireTime,
} from "../reminders";

async function setAwaiting(phone: string, user: any, value: string | null): Promise<void> {
  user.awaitingInputType = value;
  await db.update(users).set({ awaitingInputType: value }).where(eq(users.phoneNumber, phone))
    .catch((e) => console.error("[REMINDER] awaiting set failed:", e));
}

export async function handleReminderCommand(ctx: {
  phone: string; message: string; m: string; user: any;
}): Promise<string | null> {
  const { phone, message, m, user } = ctx;
  const firstName = (user.name || "").split(" ")[0] || "";
  const hi = firstName ? `${firstName}, ` : "";

  // ---- FOLLOW-UP: we asked for a TIME, this message supplies it ----
  const awaiting = String(user.awaitingInputType || "");
  if (awaiting.startsWith("reminder_time::")) {
    const body = awaiting.slice("reminder_time::".length);
    const parsed = parseReminderRequest(`remind me to ${body} ${message}`);
    if (parsed && parsed.kind === "set") {
      await setAwaiting(phone, user, null);
      await createReminder(user.id, phone, parsed.body || body, parsed.fireAt);
      const reply = `Got it — I'll remind you to ${parsed.body || body} ${describeFireTime(parsed.fireAt)}. ✅`;
      await logChat(user.id, message, reply, "REMINDER_SET");
      return reply;
    }
    // Still no time — one gentle retry, then stand down so we don't trap them.
    await setAwaiting(phone, user, null);
    const reply = `${hi}I couldn't catch a time there. Try again like "remind me to ${body} at 8pm" whenever you're ready.`;
    await logChat(user.id, message, reply, "REMINDER_NO_TIME");
    return reply;
  }

  // ---- FOLLOW-UP: we asked WHAT to remind them about ----
  if (awaiting.startsWith("reminder_body::")) {
    const fireMs = parseInt(awaiting.slice("reminder_body::".length), 10);
    if (Number.isFinite(fireMs)) {
      const body = message.trim().slice(0, 240);
      await setAwaiting(phone, user, null);
      if (body.length >= 2) {
        await createReminder(user.id, phone, body, new Date(fireMs));
        const reply = `Done — I'll remind you to ${body} ${describeFireTime(new Date(fireMs))}. ✅`;
        await logChat(user.id, message, reply, "REMINDER_SET");
        return reply;
      }
    }
    await setAwaiting(phone, user, null);
    // fall through — nothing to remind about
  }

  // ---- LIST: "my reminders", "what reminders do I have" ----
  if (/\b(list|show|view|see|check|my|any|what'?s?)\b[^.?!]{0,18}\breminders?\b/i.test(m)
      || /^reminders?\??$/i.test(m.trim())) {
    const pending = await listPendingReminders(user.id);
    if (!pending.length) {
      const reply = `${hi}you have no reminders set. Say something like "remind me to weigh in tomorrow at 7am" and I'll hold it for you.`;
      await logChat(user.id, message, reply, "REMINDER_LIST_EMPTY");
      return reply;
    }
    const lines = pending.map((r) => `• ${r.body} — ${describeFireTime(new Date(r.fireAt as any))}`).join("\n");
    const reply = `${hi}here's what I'm holding for you:\n\n${lines}\n\nSay *cancel reminders* to clear them.`;
    await logChat(user.id, message, reply, "REMINDER_LIST");
    return reply;
  }

  // ---- CANCEL: "cancel my reminders", "clear reminders" ----
  if (/\b(cancel|clear|delete|remove|stop|forget|scrap)\b[^.?!]{0,18}\breminders?\b/i.test(m)) {
    const n = await cancelAllReminders(user.id);
    const reply = n > 0
      ? `${hi}cleared ${n === 1 ? "your reminder" : `all ${n} reminders`}. ✅`
      : `${hi}you had no reminders to clear.`;
    await logChat(user.id, message, reply, "REMINDER_CANCEL");
    return reply;
  }

  // ---- SET: "remind me to X at Y" ----
  const parsed = parseReminderRequest(message);
  if (!parsed) return null; // not a reminder request — let the pipeline continue

  if (parsed.kind === "set") {
    await createReminder(user.id, phone, parsed.body, parsed.fireAt);
    const reply = `Got it — I'll remind you to ${parsed.body} ${describeFireTime(parsed.fireAt)}. ✅`;
    await logChat(user.id, message, reply, "REMINDER_SET");
    return reply;
  }
  if (parsed.kind === "need_time") {
    await setAwaiting(phone, user, `reminder_time::${parsed.body.slice(0, 180)}`);
    const reply = `${hi}when should I remind you to ${parsed.body}? (e.g. "at 8pm", "tomorrow morning", "in 2 hours")`;
    await logChat(user.id, message, reply, "REMINDER_ASK_TIME");
    return reply;
  }
  // need_body
  await setAwaiting(phone, user, `reminder_body::${parsed.fireAt.getTime()}`);
  const reply = `${hi}what should I remind you about ${describeFireTime(parsed.fireAt)}?`;
  await logChat(user.id, message, reply, "REMINDER_ASK_BODY");
  return reply;
}
