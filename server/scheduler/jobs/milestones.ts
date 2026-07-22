import {
  db, weightLogs, stepLogs, mealLogs,
  eq, asc, desc, and, gte, sql,
  sendWhatsApp, canSendProactive, recordProactiveSend, claimProactive,
  getActiveClients, isPaused, programmeDaysSince, loadState, saveState,
} from "../shared";
import { generateVoiceNote } from "../../tts";
import { generateMilestoneVoiceScript } from "../../gpt";
import { stepBurnKcal } from "../../targets";

// Day-14 receipt stats (2026-07-13, Kam: "people lose interest within two weeks — we
// have to do better in our retention"). The two-week quit happens because the mirror
// hasn't changed and the client has no PROOF it's working. We have the proof in the DB —
// show the receipt, not a pep talk. All fields optional: lines silently drop when a
// stat wasn't logged, never guilt.
export interface TwoWeekStats {
  steps14?: number;          // total steps logged across the 14 days
  stepsBurnKcal?: number;    // weight-scaled kcal equivalent of those steps
  mealDays14?: number;       // distinct days with food logged
  weightStart?: number | null;
  weightNow?: number | null;
  goal?: string;
}

export function buildDayMilestoneMessage(name: string, days: number, workouts: number, weightKg: string | null, stats?: TwoWeekStats): string {
  // DAY 3 — the first cliff (2026-07-13 retention reports: people vanish on day 3-5,
  // and our earliest proactive milestone was day 7 — nothing landed on the exact day
  // the old voice starts whispering "this is too hard"). Quit-prevention, Kam's voice:
  // name the voice, call it a liar, ask for ONE word back. Sent with a voice note when
  // ElevenLabs is configured — a human voice on the danger day, not a text template.
  if (days === 3) return `${name}, day 3. This is the day your old brain starts whispering *"this is too hard."*\n\nI'm not going to tell you it's easy. I'm telling you that voice is lying — it said the same thing every other time you started. And every other time, you listened.\n\nNot this time. Reply one word: *"Here."* That's all I need today.`;
  if (days === 7) return `${name}, seven days in. ${workouts > 0 ? `${workouts} session${workouts > 1 ? "s" : ""} done.` : "Keep building."} Most people quit before week two — you are still here.\n\n🔓 *Week 2 unlocked:* Your programme steps up in intensity this week. Send your weight today so I can calibrate.`;
  if (days === 14) {
    // The receipt: every line is a FACT they created. Claims don't retain; proof does.
    const receipt: string[] = [];
    if (workouts > 0) receipt.push(`💪 *${workouts} training session${workouts !== 1 ? "s" : ""}* — showed up and did the work`);
    if (stats?.steps14 && stats.steps14 >= 5000) {
      const kmApprox = Math.round(stats.steps14 / 1300);
      receipt.push(`👟 *${stats.steps14.toLocaleString()} steps walked* (~${kmApprox}km)${stats.stepsBurnKcal ? ` — roughly ${stats.stepsBurnKcal.toLocaleString()} kcal burned on your feet alone` : ""}`);
    }
    if (stats?.mealDays14 && stats.mealDays14 >= 3) receipt.push(`🍽 *${stats.mealDays14} day${stats.mealDays14 !== 1 ? "s" : ""} of meals logged* — you know what's going in now`);
    if (stats?.weightStart != null && stats?.weightNow != null && Math.abs(stats.weightNow - stats.weightStart) >= 0.3) {
      const diff = stats.weightNow - stats.weightStart;
      const goal = (stats.goal || "fat_loss").toLowerCase();
      if (diff < 0) receipt.push(goal === "muscle_gain"
        ? `⚖️ *${Math.abs(diff).toFixed(1)}kg down* — we'll add fuel; the training is clearly working`
        : `⚖️ *${Math.abs(diff).toFixed(1)}kg down already* — and this is just the start`);
      else receipt.push(goal === "muscle_gain"
        ? `⚖️ *${diff.toFixed(1)}kg up* — that's building fuel doing its job`
        : `⚖️ scale up ${diff.toFixed(1)}kg — normal at 2 weeks (water + muscle adapting), the trend bends from week 3`);
    }
    const receiptBlock = receipt.length >= 2
      ? `\n\n*Your 2-week receipt — this actually happened:*\n${receipt.join("\n")}\n`
      : workouts > 0 ? ` ${workouts} sessions logged.` : " The habit is forming.";
    return `${name}, two weeks. 🏁${receiptBlock}\nThis is exactly when most people quit — because the mirror changes at week 4–6, not week 2. But the numbers above are real, and they're already yours. The people who get results are the ones still here at week 3.\n\nDon't stop now — you're closer than you think.\n\n[BUTTONS:Today's workout|My progress]`;
  }
  if (days === 30) {
    const weightLine = weightKg ? `You started at ${weightKg}kg. ` : "";
    return `${name}, 30 days. ${weightLine}${workouts} workouts completed. The people who last 30 days are the ones who get results — and you are one of them. Progress photo today — front on, same spot, relaxed. Send it, and tell me how your energy's been.`;
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
      // Day 3 included (2026-07-13): the first quit cliff — see buildDayMilestoneMessage.
      if ([3, 7, 14, 30, 60, 90, 180, 365].includes(days)) {
        if (await claimProactive(client.id, "day_milestone", `d${days}`)) {
          const firstWeight = await db.select({ weight: weightLogs.weight })
            .from(weightLogs).where(eq(weightLogs.userId, client.id)).orderBy(asc(weightLogs.loggedAt)).limit(1);
          const firstWeightKg = firstWeight[0]?.weight ? String(firstWeight[0].weight) : null;
          // Day 14 gets the RECEIPT — real numbers from their own two weeks (retention
          // wall: proof beats pep talk). All queries best-effort; missing stats drop.
          let stats: TwoWeekStats | undefined;
          if (days === 14) {
            try {
              const since = new Date(Date.now() - 14 * 86_400_000);
              const [stepSum, mealDays, latestWeight] = await Promise.all([
                db.select({ total: sql<number>`COALESCE(SUM(${stepLogs.steps}), 0)::int` })
                  .from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, since))).then(r => r[0]),
                db.select({ days: sql<number>`COUNT(DISTINCT DATE(${mealLogs.loggedAt}))::int` })
                  .from(mealLogs).where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, since))).then(r => r[0]),
                db.select({ weight: weightLogs.weight })
                  .from(weightLogs).where(eq(weightLogs.userId, client.id)).orderBy(desc(weightLogs.loggedAt)).limit(1).then(r => r[0]),
              ]);
              const steps14 = stepSum?.total || 0;
              const wKg = client.currentWeight ? parseFloat(String(client.currentWeight)) : undefined;
              stats = {
                steps14,
                stepsBurnKcal: steps14 > 0 ? stepBurnKcal(steps14, wKg) : undefined,
                mealDays14: mealDays?.days || 0,
                weightStart: firstWeightKg ? parseFloat(firstWeightKg) : null,
                weightNow: latestWeight?.weight ? parseFloat(String(latestWeight.weight)) : null,
                goal: client.goalType || "fat_loss",
              };
            } catch (statErr) { console.warn("[MILESTONE] day-14 stats fetch failed — sending without receipt:", statErr); }
          }
          const msg = buildDayMilestoneMessage(name, days, workouts, firstWeightKg, stats);
          // Day 3 lands as a VOICE note when configured — a human voice on the quit
          // cliff beats a text template (text always sends as the body regardless).
          let dayVoiceUrl: string | null = null;
          if (days === 3 && msg) {
            dayVoiceUrl = await generateVoiceNote(msg.replace(/[*_]/g, ""), "warm", client.id).catch(() => null);
          }
          if (msg) await sendWhatsApp(client.phoneNumber, msg, dayVoiceUrl || undefined);
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
            voiceUrl = await generateVoiceNote(script, emotion, client.id);
          } catch (voiceErr) {
            console.warn("[MILESTONE] Voice script failed, using text:", voiceErr);
            voiceUrl = await generateVoiceNote(text, "celebratory", client.id).catch(() => null);
          }
        }
        await sendWhatsApp(client.phoneNumber, text, voiceUrl || undefined);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Milestone error — ${client.phoneNumber}:`, err);
    }
  }
}
