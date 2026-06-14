import {
  db, weightLogs,
  eq, asc,
  sendWhatsApp, canSendProactive, recordProactiveSend, claimProactive,
  getActiveClients, isPaused, programmeDaysSince, loadState, saveState,
} from "../shared";
import { generateVoiceNote } from "../../tts";
import { generateMilestoneVoiceScript } from "../../gpt";

export function buildDayMilestoneMessage(name: string, days: number, workouts: number, weightKg: string | null): string {
  if (days === 7) return `${name}, seven days in. ${workouts > 0 ? `${workouts} session${workouts > 1 ? "s" : ""} done.` : "Keep building."} Most people quit before week two — you are still here.\n\n🔓 *Week 2 unlocked:* Your programme steps up in intensity this week. Send your weight today so I can calibrate.`;
  if (days === 14) return `${name}, two weeks. ${workouts > 0 ? `${workouts} sessions logged.` : "The habit is forming."} Two weeks is when the body starts adapting — not just to training, but to the routine itself.\n\n🔓 *Consistency badge:* You have shown up for 14 days. That puts you ahead of 80% of people who start. Keep this momentum into week 3.`;
  if (days === 30) {
    const weightLine = weightKg ? `You started at ${weightKg}kg. ` : "";
    return `${name}, 30 days. ${weightLine}${workouts} workouts completed. The people who last 30 days are the ones who get results — and you are one of them. Measurements today — waist, hips, chest. Send them to me.`;
  }
  if (days === 60) return `${name}, 60 days. ${workouts} sessions logged. That kind of consistency is genuinely rare — most people have been and gone twice already. Send your weight today. I want to see the 60-day number.`;
  if (days === 90) return `${name}, 90 days and ${workouts} workouts. You have built a real habit now. This is where things compound — the next 90 will look different because your body is different. Progress photo today. Send it to me.`;
  if (days === 180) return `${name}, 6 months. ${workouts} workouts. Whatever brought you here — it worked. Progress photo today. I want to see what 180 days of work looks like on your body.`;
  if (days === 365) return `${name}, one year. I do not have words for what you have done this year. ${workouts} workouts. 365 days. Send me a photo. This moment deserves to be seen.`;
  return "";
}

export const WORKOUT_MILESTONES: Record<number, (name: string) => string> = {
  1:   (n) => `${n} — first session done. 🎉 That's the hardest one. Every session from here is proof you're not just talking about it.`,
  3:   (n) => `${n}, 3 sessions in. The habit is starting. Most people who make it to 3 make it to 10. Keep going.`,
  5:   (n) => `${n}, 5 sessions. 🔥 High five. You've officially started. Some people joined the same day as you and have already quit — you haven't.`,
  10:  (n) => `${n}, 10 sessions done. That is the first real milestone — most people never get here. The habit is forming. Keep going.`,
  25:  (n) => `${n}, 25 workouts. A quarter century of sessions. You are not talking about fitness anymore. You are doing it.`,
  50:  (n) => `${n}, 50 sessions. Fifty times you showed up when you could have stayed home. That is not motivation — that is discipline. Lekker work.`,
  100: (n) => `${n}, 100 workouts. One hundred sessions. That number puts you in a category most people never reach. Whatever happens next — you earned this.`,
};

export async function runMilestoneCelebrations(): Promise<void> {
  console.log("[SCHEDULER] JOB: Milestone celebrations");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      const workouts = client.totalWorkoutsCompleted || 0;
      const days = programmeDaysSince(client.programmeStartDate);

      // Day milestone — DB claim so a container recycle on the milestone day can't re-send.
      if ([7, 14, 30, 60, 90, 180, 365].includes(days)) {
        if (await claimProactive(client.id, "day_milestone", `d${days}`)) {
          const firstWeight = await db.select({ weight: weightLogs.weight })
            .from(weightLogs).where(eq(weightLogs.userId, client.id)).orderBy(asc(weightLogs.loggedAt)).limit(1);
          const firstWeightKg = firstWeight[0]?.weight ? String(firstWeight[0].weight) : null;
          const msg = buildDayMilestoneMessage(name, days, workouts, firstWeightKg);
          if (msg) await sendWhatsApp(client.phoneNumber, msg);
        }
      }

      const workoutMilestoneText = WORKOUT_MILESTONES[workouts];
      if (workoutMilestoneText) {
        // DB claim per milestone count — replaces the state-file flag a recycle would wipe.
        if (!(await claimProactive(client.id, "workout_milestone", `w${workouts}`))) continue;
        const text = workoutMilestoneText(name);
        let voiceUrl: string | null = null;
        if ([25, 50, 100].includes(workouts)) {
          try {
            const { script, emotion } = await generateMilestoneVoiceScript(client, "workout_sessions", { sessions: workouts });
            voiceUrl = await generateVoiceNote(script, emotion);
          } catch (voiceErr) {
            console.warn("[MILESTONE] Voice script failed, using text:", voiceErr);
            voiceUrl = await generateVoiceNote(text, "celebratory").catch(() => null);
          }
        }
        await sendWhatsApp(client.phoneNumber, text, voiceUrl || undefined);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Milestone error — ${client.phoneNumber}:`, err);
    }
  }
}
