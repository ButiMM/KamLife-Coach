// Sick flow (2026-07-13) — extracted from early-commands.ts for the file-size budget.
// Question-aware, repeat-aware, duration-aware sickness handling: comeback questions
// get the plan; repeat mentions get a short human variant; the FIRST report parses
// the duration, remembers it (sick_until) and holds the whole proactive machine
// (paused_until — every scheduler job checks isPaused). Recovery clears both.

import { db } from "../db";
import { users } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { logChat } from "./chat-log";
import { parseSickDays, isReturnFromSicknessQuestion } from "../utils";

// The sickness-mention regex — also used by early-commands for the return-planning guard.
export function looksSickMention(m: string): boolean {
  return /\b(sick|ill|flu|flue|flu.?like|fever|vomit|nausea|nauseous|throwing up|stomach bug|food poison|covid|covid.?19|not well|not feeling well|feeling sick|feeling ill|feel sick|feel ill|i.?m sick|i.?m ill|under the weather|hospital|doctor.?s|clinic|bed rest|body aches|headache.*bad|migraine|tonsil|sore throat|chest.*tight|can.?t breathe|difficulty breathing)\b/i.test(m)
    && !/\b(used to be sick|was sick last week|recovered|feeling better now|back to normal|got better|all better|not sick|not ill|not unwell|i.?m not sick|no longer sick|not sick anymore|i.?m better|i.?m fine now|i.?m okay now|i.?m ok now|feel better|feeling better|better now|i.?m well|i.?m healthy|recovered from|over the|over it now)\b/i.test(m);
}

export async function handleSickFlow(ctx: { message: string; m: string; user: any; capName: string }): Promise<string | null> {
  const { message, m, user, capName } = ctx;
  // ---- SICK / ILL — above-neck vs below-neck rule ----
  const isAboveNeckOnly = /\b(runny nose|blocked nose|stuffy nose|sneezing|sneezy|light cold|mild cold|bit of a cold|slight headache|congested|congestion)\b/i.test(m)
    && !/\b(fever|vomit|nausea|nauseous|throwing up|stomach|chest|flu|covid|body aches|can.?t breathe|diarr|diarrhoea)\b/i.test(m);
  const isSick = /\b(sick|ill|flu|flue|flu.?like|fever|vomit|nausea|nauseous|throwing up|stomach bug|food poison|covid|covid.?19|not well|not feeling well|feeling sick|feeling ill|feel sick|feel ill|i.?m sick|i.?m ill|under the weather|hospital|doctor.?s|clinic|bed rest|body aches|headache.*bad|migraine|tonsil|sore throat|chest.*tight|can.?t breathe|difficulty breathing)\b/i.test(m)
    && !/\b(used to be sick|was sick last week|recovered|feeling better now|back to normal|got better|all better|not sick|not ill|not unwell|i.?m not sick|no longer sick|not sick anymore|i.?m better|i.?m fine now|i.?m okay now|i.?m ok now|feel better|feeling better|better now|i.?m well|i.?m healthy|recovered from|over the|over it now)\b/i.test(m);
  if (isAboveNeckOnly) {
    const aboveNeckReply = `${capName}, above-the-neck rule: runny nose or congestion = light training is fine.\n\nYou can train — but drop the intensity. A 30-min walk, a light session at 60% effort. If you feel worse during warm-up, stop and rest. No heavy lifts, no max effort today.\n\n*Eat well:* protein + fluids. Vitamin C from fruit or juice. You'll be back to full speed in a day or two.`;
    await logChat(user.id, message, aboveNeckReply, "SICK_ABOVE_NECK");
    return aboveNeckReply;
  }
  if (isSick) {
    // SICK FLOW REWORK (2026-07-13, the flu screenshots): the old handler fired the
    // SAME template on ANY sickness mention — four verbatim sends in one day, twice in
    // reply to "what happens when I come back?", while proactive jobs kept blasting a
    // healthy-person rhythm. Now: (1) comeback QUESTIONS get the comeback plan;
    // (2) repeat mentions while already noted sick get a short human variant, never the
    // template again; (3) the FIRST report parses the duration, remembers it, and puts
    // the entire proactive machine on hold via the existing paused_until plumbing.
    const notes = user.profileNotes || "";
    const sickMatch = notes.match(/sick_until:(\d{4}-\d{2}-\d{2})/);
    const alreadySick = !!sickMatch && new Date(sickMatch[1]) >= new Date(new Date().toISOString().slice(0, 10));

    if (isReturnFromSicknessQuestion(m)) {
      const backDate = sickMatch ? sickMatch[1] : null;
      const comebackReply = `Good question — here's your comeback plan${capName ? ", " + capName : ""}:\n\n*Nothing resets.* Your programme, your week, your streak — all saved exactly where you left them. Sick days don't count against you.\n\n*First session back:* go at ~70% — lighter weights, fewer sets, listen to your body. Session two, back to normal. Your strength returns within a week; it never left, it was just resting with you.\n\n*Food while sick still counts* — keep logging what you can, no calorie pressure.\n\n${backDate ? `I've got you resting until around *${backDate}*. ` : ""}When you're ready, just say *I'm back* and I'll set up your first session.`;
      await logChat(user.id, message, comebackReply, "SICK_COMEBACK_PLAN");
      return comebackReply;
    }

    if (alreadySick) {
      // They told us already — never repeat the template. Short, human, varied by day.
      const stillSickReply = `Still resting — that's exactly right${capName ? ", " + capName : ""}. 💛 Fluids, sleep, small meals when you can.\n\nWant the plan for when you're back? Just ask *"what do I do when I'm better?"* — otherwise rest easy, I'm holding everything for you.`;
      await logChat(user.id, message, stillSickReply, "SICK_STILL");
      return stillSickReply;
    }

    const goal = user.goalType || "fat_loss";
    const programmeRef = user.trainingMode
      ? `Your ${user.trainingMode.replace(/_/g, " ")} programme is saved`
      : "Your programme and targets are saved";
    const sickDays = parseSickDays(m);
    const sickUntil = new Date(Date.now() + sickDays * 86_400_000).toISOString().slice(0, 10);
    // ONE write holds the whole proactive machine (isPaused is checked by every job)
    // and remembers the sickness for the brain snapshot + repeat suppression.
    try {
      const cleaned = notes.replace(/\s*\|?\s*(?:paused_until|sick_until):\d{4}-\d{2}-\d{2}/g, "").trim();
      const updatedNotes = `${cleaned ? cleaned + " | " : ""}sick_until:${sickUntil} | paused_until:${sickUntil}`;
      await db.update(users).set({ profileNotes: updatedNotes }).where(eq(users.id, user.id));
    } catch (e) { console.error("[SICK] failed to persist sick state:", e); }

    const nutritionLine = goal === "muscle_gain"
      ? `*Eat even if you have no appetite:* protein matters most right now — muscle breaks down fast when sick. Eggs, protein shake, yoghurt, chicken soup. Even small amounts help.`
      : `*Eat small, real food:* pap, eggs, toast, yoghurt, soup — whatever you can keep down. No calorie pressure today.`;
    const sickReply = `${capName}, no training — rest until you're properly better. Your body is fighting right now and that takes everything.\n\n${nutritionLine}\n\n• Sleep as much as you can\n• Fluids — water, Energade, soup, juice\n• No steps target while you're sick\n\n${programmeRef} — nothing resets, and I've paused your check-ins for ~${sickDays} day${sickDays !== 1 ? "s" : ""} so I'm not nagging you while you rest. Say *I'm back* when you're ready, or ask *"what do I do when I'm better?"* for your comeback plan.`;
    await logChat(user.id, message, sickReply, "SICK_DAY");
    return sickReply;
  }

  // ---- RECOVERY — "I'm back / feeling better" clears the sick hold ----
  if (/\b(i'?m back|feeling better|i'?m better|recovered|all better|ready to train|back to training|flu'?s? gone|over the flu)\b/i.test(m)
      && /sick_until:\d{4}-\d{2}-\d{2}/.test(user.profileNotes || "")) {
    try {
      const cleaned = (user.profileNotes || "").replace(/\s*\|?\s*(?:paused_until|sick_until):\d{4}-\d{2}-\d{2}/g, "").trim();
      await db.update(users).set({ profileNotes: cleaned || null }).where(eq(users.id, user.id));
    } catch (e) { console.error("[SICK] failed to clear sick state:", e); }
    const backReply = `Welcome back${capName ? ", " + capName : ""} — that's what I like to see. 💪\n\n*First session back: ~70%.* Lighter weights, fewer sets, feel it out. Session two, we're back to full speed. Nothing reset while you were out.\n\n[BUTTONS:Today's workout|Log food]`;
    await logChat(user.id, message, backReply, "SICK_RECOVERED");
    return backReply;
  }
  return null;
}
