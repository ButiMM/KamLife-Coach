import { db } from "../db";
import { users, weightLogs } from "../../shared/schema";
import { eq, and, gte, asc, desc } from "drizzle-orm";
import { calculateTargets } from "../targets";
import { storeMemory } from "../memory";
import { sastDayStart } from "../utils";
import { generateVoiceNote } from "../tts";
import { sendWhatsApp } from "../scheduler/shared";

export async function handleWeightLog(
  phone: string,
  user: any,
  newKg: number,
): Promise<string> {
  // Sanity bounds: 30kg–250kg covers from very small adolescents to severely obese adults.
  // Anything outside is almost certainly a typo (e.g. "850kg" = "85kg", "8kg" = "80kg")
  // or an OCR/Whisper error. Don't update targets, ask user to confirm.
  if (!Number.isFinite(newKg) || newKg < 30 || newKg > 250) {
    return `That weight reads as *${newKg}kg* — that doesn't look right. Send your weight again as just a number followed by kg, like "82kg" or "76.5kg".`;
  }

  const { calorieTarget: newCals, proteinTarget: newProtein } = calculateTargets(
    newKg, user.goalType || "fat_loss", user.lifeSituation || "office",
    user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170,
  );
  const prevKg = parseFloat(user.currentWeight || "0");
  const prevCals = user.calorieTarget || newCals;
  const prevProtein = user.proteinTarget || newProtein;

  await db.update(users).set({ currentWeight: newKg.toString(), calorieTarget: newCals, proteinTarget: newProtein }).where(eq(users.phoneNumber, phone));

  // Prevent duplicate weight logs — update today's entry if it exists, otherwise insert
  const todayWeightStart = sastDayStart();
  const existingToday = await db.select({ id: weightLogs.id }).from(weightLogs)
    .where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, todayWeightStart)))
    .limit(1);
  if (existingToday.length > 0) {
    await db.update(weightLogs).set({ weight: newKg.toString() }).where(eq(weightLogs.id, existingToday[0].id));
  } else {
    await db.insert(weightLogs).values({ userId: user.id, weight: newKg.toString() });
  }

  // Store win memory and build milestone celebration at total loss milestones
  let milestoneCelebration = "";
  try {
    const firstLog = await db.select({ weight: weightLogs.weight }).from(weightLogs)
      .where(eq(weightLogs.userId, user.id)).orderBy(asc(weightLogs.loggedAt)).limit(1);
    if (firstLog.length > 0) {
      const startKg = parseFloat(String(firstLog[0].weight));
      const totalLoss = startKg - newKg;
      const firstName = (user.name || "").split(" ")[0] || "there";
      const MILESTONE_MESSAGES: Record<number, string> = {
        2:  `\n\n🏆 *${firstName}, that's 2kg gone.* Two bags of sugar off your body — permanently. This is working.`,
        5:  `\n\n🏆 *${firstName}, 5kg gone.* Five kilograms. That's a bag of potatoes you were carrying everywhere. It's not coming back. Screenshot this.`,
        10: `\n\n🏆 *${firstName}, 10 kilograms.* Most people who start a programme never see 10kg. You did. Share this with someone — you've earned it.`,
        15: `\n\n🏆 *${firstName}, 15kg lost.* That is a genuinely rare thing. Tell me — what's changed beyond the scale? Energy? Sleep? How clothes fit? I want to know.`,
        20: `\n\n🏆 *${firstName}, 20 kilograms.* I have coached a lot of people. 20kg is real transformation. This is the version of you that does not go back.`,
      };
      const MILESTONE_VOICE: Record<number, string> = {
        2:  `Two kilograms gone. That is two bags of sugar your body was carrying - and now it isn't. This is working. Keep logging, keep showing up.`,
        5:  `Five kilograms. That's a bag of potatoes you were dragging around everywhere - gone. Most people never get here. You did. Screenshot this moment.`,
        10: `Ten kilograms lost. I want you to think about that. Ten kilos. Most people who start a programme never see this number. You broke through what breaks most people. This is real.`,
        15: `Fifteen kilos. That is genuinely rare. I have coached a lot of people - fifteen kilograms of fat loss is something most people only dream about. Tell me - what's changed beyond the scale? Because I promise you, everything has changed.`,
        20: `Twenty kilograms. I'm going to say that again. Twenty. Kilograms. You are not the same person who started this. That version of you does not exist anymore. Twenty kilos is transformation. This is who you are now.`,
      };
      for (const milestone of [2, 5, 10, 15, 20]) {
        if (totalLoss >= milestone && totalLoss < milestone + 0.6) {
          await storeMemory(phone, `Weight loss milestone: lost ${milestone}kg total — started at ${startKg}kg, now at ${newKg}kg`, "milestone");
          milestoneCelebration = MILESTONE_MESSAGES[milestone] || "";
          // Fire voice note in background — milestone fires at most once per client ever
          const voiceScript = MILESTONE_VOICE[milestone];
          if (voiceScript) {
            generateVoiceNote(voiceScript)
              .then(url => { if (url) return sendWhatsApp(phone, "", url); })
              .catch(err => console.warn("[TTS] Milestone voice failed:", err));
          }
          break;
        }
      }
    }
  } catch (e) { console.warn("[non-fatal]", e); }

  // Build weight change note vs last log
  let changeNote = "";
  if (prevKg > 0 && Math.abs(newKg - prevKg) > 0.1) {
    const diff = newKg - prevKg;
    const direction = diff < 0 ? `⬇️ down ${Math.abs(diff).toFixed(1)}kg` : `⬆️ up ${diff.toFixed(1)}kg`;
    changeNote = ` ${direction} from last log.`;
  }

  // Total journey progress from very first weigh-in
  let journeyNote = "";
  try {
    const [firstLog] = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt })
      .from(weightLogs).where(eq(weightLogs.userId, user.id))
      .orderBy(asc(weightLogs.loggedAt)).limit(1);
    if (firstLog) {
      const startKg = parseFloat(String(firstLog.weight));
      const totalChange = newKg - startKg;
      const weeksSinceStart = Math.max(1, Math.round((Date.now() - new Date(firstLog.loggedAt!).getTime()) / (7 * 86_400_000)));
      const pacePerWeek = Math.abs(totalChange / weeksSinceStart).toFixed(2);
      const goal = user.goalType || "fat_loss";
      if (Math.abs(totalChange) >= 0.5) {
        if (totalChange < 0 && goal === "fat_loss") {
          journeyNote = `\n\n📉 Total lost: *${Math.abs(totalChange).toFixed(1)}kg* since week 1. Pace: ${pacePerWeek}kg/week — ${parseFloat(pacePerWeek) >= 0.3 && parseFloat(pacePerWeek) <= 0.8 ? "right on target" : parseFloat(pacePerWeek) < 0.3 ? "slower than optimal — check protein and deficit" : "slightly fast — make sure you're eating enough protein"}.`;
        } else if (totalChange > 0 && goal === "muscle_gain") {
          journeyNote = `\n\n📈 Total gained: *${totalChange.toFixed(1)}kg* since week 1. Pace: ${pacePerWeek}kg/week — ${parseFloat(pacePerWeek) >= 0.1 && parseFloat(pacePerWeek) <= 0.5 ? "solid lean gain rate" : parseFloat(pacePerWeek) > 0.5 ? "gaining fast — watch body fat" : "very slow — push calories slightly"}.`;
        } else if (totalChange > 0 && goal === "fat_loss") {
          journeyNote = `\n\n📈 Up *${totalChange.toFixed(1)}kg* from starting weight of ${startKg}kg. Weight is moving the wrong way for fat loss — tighten up on carb portions and hit the protein target every day. The calories and protein targets above are your numbers.`;
        } else if (totalChange < 0 && goal === "muscle_gain") {
          journeyNote = `\n\n📉 Down *${Math.abs(totalChange).toFixed(1)}kg* from starting weight of ${startKg}kg. For muscle gain you need to be eating more — bump calories by 200/day and make sure you're hitting protein every meal.`;
        } else {
          journeyNote = `\n\n${totalChange < 0 ? "📉" : "📈"} Total change: *${totalChange > 0 ? "+" : ""}${totalChange.toFixed(1)}kg* from starting weight of ${startKg}kg.`;
        }
      }
    }
  } catch { /* non-fatal */ }

  // Build targets change note
  let targetsNote = "";
  if (Math.abs(newCals - prevCals) > 20 || Math.abs(newProtein - prevProtein) > 2) {
    targetsNote = `\n\nTargets updated: ${newCals} kcal/day | ${newProtein}g protein. (Automatically adjusted — keeps results moving.)`;
  } else {
    targetsNote = `\n\nTargets: ${newCals} kcal/day | ${newProtein}g protein.`;
  }

  // Goal reached detection
  const targetKg = parseFloat(user.targetWeightKg || "0");
  const goal = user.goalType || "fat_loss";
  if (targetKg > 0) {
    const hitGoal = (goal === "fat_loss" && newKg <= targetKg)
      || (goal === "muscle_gain" && newKg >= targetKg);
    if (hitGoal) {
      const firstName = (user.name || "").split(" ")[0] || "there";
      await db.update(users).set({ awaitingInputType: "goal_transition" }).where(eq(users.phoneNumber, phone));
      const goalVoice = goal === "fat_loss"
        ? `${firstName}. You hit your target weight. I need you to stop for a second and feel that. You set a number, you worked for it, and you are standing on it right now. That is not luck. That is you.`
        : `${firstName}. Target weight reached. Every session, every meal, every rep - it built this. You did that.`;
      generateVoiceNote(goalVoice)
        .then(url => { if (url) return sendWhatsApp(phone, "", url); })
        .catch(err => console.warn("[TTS] Goal voice failed:", err));
      return `🏆 *GOAL REACHED.*\n\nWeight logged: *${newKg}kg.*${changeNote}\n\n${firstName}, you hit your target of ${targetKg}kg. This is real — you did the work.\n\nNow we need a new direction. Reply with a number:\n\n*1* — Maintain this weight\n*2* — Build muscle\n*3* — Recomposition (hold weight, swap fat for muscle)\n\nWhat's next?`;
    }
  }

  // Plateau detection — no change >0.5kg in 3 weeks
  const threeWeeksAgo = new Date(Date.now() - 21 * 86_400_000);
  const recentWeightLogs = await db.select({ weight: weightLogs.weight })
    .from(weightLogs).where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, threeWeeksAgo)))
    .orderBy(asc(weightLogs.loggedAt));
  let plateauNote = "";
  if (recentWeightLogs.length >= 3) {
    const oldest3w = parseFloat(String(recentWeightLogs[0].weight));
    const change3w = Math.abs(newKg - oldest3w);
    if (change3w < 0.5) {
      plateauNote = `\n\nWeight has barely moved in 3 weeks. Cut carb portions by a third this week and add a 20-minute walk daily.`;
    }
  }

  return `Weight logged: *${newKg}kg.*${changeNote}${milestoneCelebration || journeyNote}${targetsNote}${plateauNote}`;
}
