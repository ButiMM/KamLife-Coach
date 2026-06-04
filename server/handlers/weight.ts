import { db } from "../db";
import { users, weightLogs } from "../../shared/schema";
import { eq, and, gte, asc, desc } from "drizzle-orm";
import { calculateTargets } from "../targets";
import { storeMemory } from "../memory";

/**
 * Assess whether a weight-change rate is safe, concerning or dangerous for the given goal.
 * Returns null when there's not enough data or the change is negligible.
 *
 * Safe bands (evidence-based):
 *  fat_loss:    0–0.5 kg/wk excellent, 0.5–1 ok, 1–1.5 warn, >1.5 alert, >2.5 danger
 *  recomposition: 0–0.4 kg/wk fine, 0.4–0.75 warn, >0.75 alert
 *  muscle_gain: should be gaining or flat; any consistent loss is a problem
 */
export function assessWeightRate(
  totalChangeKg: number,
  weeksSinceStart: number,
  goal: string,
  proteinTarget: number,
  calorieTarget: number,
  name: string,
): string | null {
  if (weeksSinceStart < 1 || Math.abs(totalChangeKg) < 0.5) return null;
  const pace = Math.abs(totalChangeKg) / weeksSinceStart;
  const nm = name ? `${name}, ` : "";

  if (totalChangeKg < 0 && (goal === "fat_loss" || goal === "recomposition")) {
    const maxSafe = goal === "fat_loss" ? 1.0 : 0.75;
    const maxWarn = goal === "fat_loss" ? 1.5 : 0.75;
    if (pace <= (goal === "fat_loss" ? 0.5 : 0.4)) {
      return `📉 Total lost: *${Math.abs(totalChangeKg).toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — ✅ right on target, sustainable.`;
    } else if (pace <= maxSafe) {
      return `📉 Total lost: *${Math.abs(totalChangeKg).toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — ✅ good, at the high end of safe. Keep protein at ${proteinTarget}g daily.`;
    } else if (pace <= maxWarn) {
      return `📉 Total lost: *${Math.abs(totalChangeKg).toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — ⚠️ *faster than ideal.* At this pace you're likely losing muscle alongside fat. Hit ${proteinTarget}g protein every single day — that's what protects your muscle while you lose fat.`;
    } else if (pace <= 2.5) {
      return `📉 Total lost: *${Math.abs(totalChangeKg).toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — 🚨 *this is too fast.* Losing this quickly causes muscle loss, metabolic slowdown and rebound weight gain. Add 200 kcal/day and hit ${proteinTarget}g protein. Your target is ${calorieTarget} kcal — are you reaching it?`;
    } else {
      return `🚨 *${nm}this weight loss rate is dangerous.* ${pace.toFixed(2)}kg per week — that's crash-diet territory. At this pace your body is burning muscle, not just fat, and your metabolism will slow down hard. Please tell me what you've been eating — something is seriously wrong with your intake.`;
    }
  }

  if (totalChangeKg < 0 && goal === "muscle_gain") {
    return pace > 0.3
      ? `🚨 *${nm}you're losing weight on a muscle-building programme.* Down ${Math.abs(totalChangeKg).toFixed(1)}kg — you cannot build muscle in this deficit. You need to eat MORE: push to ${calorieTarget} kcal and ${proteinTarget}g protein every day. What's your typical day of eating look like?`
      : `⚠️ Down *${Math.abs(totalChangeKg).toFixed(1)}kg* on a muscle gain programme. You need a calorie surplus — are you hitting ${calorieTarget} kcal daily?`;
  }

  if (totalChangeKg > 0 && goal === "muscle_gain") {
    if (pace >= 0.1 && pace <= 0.5) return `📈 Total gained: *${totalChangeKg.toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — ✅ solid lean gain rate.`;
    if (pace > 0.5) return `📈 Total gained: *${totalChangeKg.toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — gaining fast, watch body fat levels.`;
    return `📈 Total gained: *${totalChangeKg.toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — very slow. Push calories up slightly.`;
  }

  if (totalChangeKg > 0 && goal === "fat_loss") {
    return `📈 Up *${totalChangeKg.toFixed(1)}kg* since starting. Weight is moving the wrong way for fat loss — tighten carb portions and hit ${proteinTarget}g protein every day.`;
  }

  return `${totalChangeKg < 0 ? "📉" : "📈"} Total change: *${totalChangeKg > 0 ? "+" : ""}${totalChangeKg.toFixed(1)}kg*.`;
}
import { sastDayStart } from "../utils";
import { generateVoiceNote } from "../tts";
import { sendWhatsApp } from "../scheduler/shared";
import { generateMilestoneVoiceScript } from "../gpt";

export async function handleWeightLog(
  phone: string,
  user: any,
  newKg: number,
): Promise<string> {
  if (!Number.isFinite(newKg) || newKg < 30 || newKg > 250) {
    return `That weight reads as *${newKg}kg* — that doesn't look right. Send your weight again as just a number followed by kg, like "82kg" or "76.5kg".`;
  }

  const { calorieTarget: newCals, proteinTarget: newProtein } = calculateTargets(
    newKg, user.goalType || "fat_loss", user.lifeSituation || "office",
    user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170, user.trainingExperience || "beginner",
  );
  const prevKg = parseFloat(user.currentWeight || "0");
  const prevCals = user.calorieTarget || newCals;
  const prevProtein = user.proteinTarget || newProtein;

  await db.update(users).set({ currentWeight: newKg.toString(), calorieTarget: newCals, proteinTarget: newProtein }).where(eq(users.phoneNumber, phone));

  const todayWeightStart = sastDayStart();
  const existingToday = await db.select({ id: weightLogs.id }).from(weightLogs)
    .where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, todayWeightStart)))
    .limit(1);
  if (existingToday.length > 0) {
    await db.update(weightLogs).set({ weight: newKg.toString() }).where(eq(weightLogs.id, existingToday[0].id));
  } else {
    await db.insert(weightLogs).values({ userId: user.id, weight: newKg.toString() });
  }

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
      for (const milestone of [2, 5, 10, 15, 20]) {
        if (totalLoss >= milestone && totalLoss < milestone + 0.6) {
          await storeMemory(phone, `Weight loss milestone: lost ${milestone}kg total — started at ${startKg}kg, now at ${newKg}kg`, "milestone");
          milestoneCelebration = MILESTONE_MESSAGES[milestone] || "";
          generateMilestoneVoiceScript(user, "weight_loss", { kgLost: milestone, currentKg: newKg, startKg })
            .then(script => generateVoiceNote(script))
            .then(url => { if (url) return sendWhatsApp(phone, "", url); })
            .catch(err => console.warn("[TTS] Milestone voice failed:", err));
          break;
        }
      }
    }
  } catch (e) { console.warn("[non-fatal]", e); }

  let changeNote = "";
  if (prevKg > 0 && Math.abs(newKg - prevKg) > 0.1) {
    const diff = newKg - prevKg;
    const direction = diff < 0 ? `⬇️ down ${Math.abs(diff).toFixed(1)}kg` : `⬆️ up ${diff.toFixed(1)}kg`;
    changeNote = ` ${direction} from last log.`;
  }

  let journeyNote = "";
  try {
    const [firstLog] = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt })
      .from(weightLogs).where(eq(weightLogs.userId, user.id))
      .orderBy(asc(weightLogs.loggedAt)).limit(1);
    if (firstLog) {
      const startKg = parseFloat(String(firstLog.weight));
      const totalChange = newKg - startKg;
      const weeksSinceStart = Math.max(1, (Date.now() - new Date(firstLog.loggedAt!).getTime()) / (7 * 86_400_000));
      const firstName = (user.name || "").split(" ")[0] || "";
      const rateNote = assessWeightRate(totalChange, weeksSinceStart, user.goalType || "fat_loss", newProtein, newCals, firstName);
      if (rateNote) journeyNote = `\n\n${rateNote}`;
    }
  } catch { /* non-fatal */ }

  let targetsNote = "";
  if (Math.abs(newCals - prevCals) > 20 || Math.abs(newProtein - prevProtein) > 2) {
    targetsNote = `\n\nTargets updated: ${newCals} kcal/day | ${newProtein}g protein. (Automatically adjusted — keeps results moving.)`;
  } else {
    targetsNote = `\n\nTargets: ${newCals} kcal/day | ${newProtein}g protein.`;
  }

  const targetKg = parseFloat(user.targetWeightKg || "0");
  const goal = user.goalType || "fat_loss";
  if (targetKg > 0) {
    const hitGoal = (goal === "fat_loss" && newKg <= targetKg)
      || (goal === "muscle_gain" && newKg >= targetKg);
    if (hitGoal) {
      const firstName = (user.name || "").split(" ")[0] || "there";
      await db.update(users).set({ awaitingInputType: "goal_transition" }).where(eq(users.phoneNumber, phone));
      const goalMilestone = goal === "fat_loss" ? "goal_reached_fat_loss" : "goal_reached_muscle";
      const kgLostTotal = prevKg - newKg;
      generateMilestoneVoiceScript(user, goalMilestone, { currentKg: newKg, startKg: prevKg || newKg, kgLost: Math.max(0, kgLostTotal) })
        .then(script => generateVoiceNote(script))
        .then(url => { if (url) return sendWhatsApp(phone, "", url); })
        .catch(err => console.warn("[TTS] Goal voice failed:", err));
      return `🏆 *GOAL REACHED.*\n\nWeight logged: *${newKg}kg.*${changeNote}\n\n${firstName}, you hit your target of ${targetKg}kg. This is real — you did the work.\n\nNow we need a new direction. Reply with a number:\n\n*1* — Maintain this weight\n*2* — Build muscle\n*3* — Recomposition (hold weight, swap fat for muscle)\n\nWhat's next?`;
    }
  }

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
