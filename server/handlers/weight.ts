import { db } from "../db";
import { users, weightLogs } from "../../shared/schema";
import { eq, and, gte, asc } from "drizzle-orm";
import { calculateTargets } from "../targets";
import { storeMemory } from "../memory";

export async function handleWeightLog(
  phone: string,
  user: any,
  newKg: number,
): Promise<string> {
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

  // Store win memory at total loss milestones
  try {
    const firstLog = await db.select({ weight: weightLogs.weight }).from(weightLogs)
      .where(eq(weightLogs.userId, user.id)).orderBy(asc(weightLogs.loggedAt)).limit(1);
    if (firstLog.length > 0) {
      const startKg = parseFloat(String(firstLog[0].weight));
      const totalLoss = startKg - newKg;
      for (const milestone of [2, 5, 10, 15, 20]) {
        if (totalLoss >= milestone && totalLoss < milestone + 0.6) {
          await storeMemory(phone, `Weight loss milestone: lost ${milestone}kg total — started at ${startKg}kg, now at ${newKg}kg`, "milestone");
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
        } else if (Math.abs(totalChange) >= 0.5) {
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

  return `Weight logged: *${newKg}kg.*${changeNote}${journeyNote}${targetsNote}${plateauNote}`;
}
