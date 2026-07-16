import { db } from "../db";
import { chatHistory, mealLogs, workoutLogs, stepLogs, exerciseLogs } from "../../shared/schema";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { sastDayStart } from "../utils";
import { cleanExerciseName, canonicalLiftKey } from "../programme";

export const JUNK_WORDS = [
  "kfc", "niknaks", "cool drink", "fanta",
  "hennessy", "henny", "alcohol", "steers", "burger", "pizza",
  "chips", "beer", "wine", "chocolate", "sweets", "biscuit",
  "russian sausage", // "russian salad" is not junk — only the processed sausage is
  // Removed: kota, fat cake, magwinya, vetkoek, polony, viennas — SA cultural / budget staples
];

function isJunk(msg: string): boolean {
  // "coke" needs word boundary to avoid matching "artichoke"
  if (/\bcoke\b/i.test(msg)) return true;
  return JUNK_WORDS.some(w => msg.includes(w));
}

export async function checkFoodPatterns(userId: string, calorieCeilingHit = false): Promise<string | null> {
  try {
    const todayStart = sastDayStart();
    const recent = await db.select().from(chatHistory)
      .where(and(eq(chatHistory.userId, userId), eq(chatHistory.intent, "FOOD_LOG")))
      .orderBy(desc(chatHistory.createdAt))
      .limit(5);

    if (recent.length < 3) return null;

    const last3 = recent.slice(0, 3).map(r => (r.messageIn || "").toLowerCase());

    const junkStreak = last3.filter(msg => isJunk(msg)).length;
    if (junkStreak >= 3) {
      return `Three takeaway/junk logs in a row — noticed. No drama. Just make the next meal protein-first: eggs, chicken, beans, or tuna. That's the reset.`;
    }

    // Positive reset: if damage control was sent today and the most recent meal is clean, acknowledge the recovery
    const mostRecent = last3[0];
    const isCleanMeal = !isJunk(mostRecent);
    if (isCleanMeal && recent.length >= 2) {
      const damageToday = await db.select({ id: chatHistory.id }).from(chatHistory)
        .where(and(eq(chatHistory.userId, userId), eq(chatHistory.intent, "DAMAGE_CONTROL"), gte(chatHistory.createdAt, todayStart)))
        .limit(1);
      const recoveryAlreadySent = await db.select({ id: chatHistory.id }).from(chatHistory)
        .where(and(eq(chatHistory.userId, userId), eq(chatHistory.intent, "DAMAGE_RECOVERY"), gte(chatHistory.createdAt, todayStart)))
        .limit(1);
      if (damageToday.length > 0 && recoveryAlreadySent.length === 0) {
        await db.insert(chatHistory).values({ userId, messageIn: "[system]", messageOut: "[damage_recovery_sent]", intent: "DAMAGE_RECOVERY" });
        return `Good. That's the right call. One clean meal after a rough one is all it takes — the damage is already being undone. Keep going.`;
      }
    }

    // Use mealLogs.proteinInt for the protein streak check — text-based detection
    // misses photo meals where messageIn is "[Photo]" even if the image had chicken/eggs.
    const recentMealLogs = await db.select({ proteinInt: mealLogs.proteinInt })
      .from(mealLogs)
      .where(eq(mealLogs.userId, userId))
      .orderBy(desc(mealLogs.loggedAt))
      .limit(3);

    if (recentMealLogs.length >= 3) {
      const noProteinStreak = recentMealLogs.filter(r => (r.proteinInt || 0) === 0).length;
      if (noProteinStreak >= 3) {
        if (calorieCeilingHit) {
          return `⚠️ *Protein pattern:* Three meals in a row without protein. Carry protein into tomorrow's first meal — eggs or chicken at breakfast covers the gap.`;
        }
        return `⚠️ *Protein missing:* Three meals in a row with no protein logged. Your muscle target and fat loss both depend on hitting your protein. Eggs, tinned tuna, chicken, or beans — pick one for the next meal.`;
      }
    }

    return null;
  } catch (e) {
    console.warn("[non-fatal]", e);
    return null;
  }
}

const DAMAGE_TRIGGERS = [
  "kfc", "mcdonald", "pizza", "burger", "vetkoek", "fat cake", "magwinya", "kotas", "pies",
  "cool drink", "fanta", "sprite", "energy drink", "cake",
  "takeaway", "takeout", "junk", "bad meal", "cheat", "splurge", "ate everything", "binge",
  "chips", "biscuit", "chocolate", "sweets",
];

export async function getDamageControlNote(userId: string, message: string): Promise<string> {
  const lowerMsg = message.toLowerCase();
  const triggerCount = DAMAGE_TRIGGERS.filter(t => t === "coke"
    ? /\bcoke\b/i.test(lowerMsg)
    : lowerMsg.includes(t)
  ).length;
  // ALCOHOL BINGE (2026-07-16 founder review: 'what does it say when they go over with
  // alcohol?' — nothing fired): 3+ drinks logged/confessed counts as damage on its own.
  const alcoholBinge = /\b([3-9]|\d{2,})\s*(beers?|shots?|ciders?|drinks?|glasses (of )?wine|savannas?|castles?|black labels?)\b/i.test(lowerMsg)
    || /\b(drank|had) (a lot|too much|way too much|heavily)\b.{0,20}\b(beer|wine|alcohol|booze)\b/i.test(lowerMsg)
    || /\b(hungover|hangover|babalaas|babelas)\b/i.test(lowerMsg);
  if (triggerCount < 2 && !alcoholBinge) return "";
  const todayStart = sastDayStart();
  const recentDamage = await db.select({ id: chatHistory.id }).from(chatHistory)
    .where(and(eq(chatHistory.userId, userId), eq(chatHistory.intent, "DAMAGE_CONTROL"), gte(chatHistory.createdAt, todayStart)))
    .limit(1);
  if (recentDamage.length > 0) return "";
  await db.insert(chatHistory).values({ userId, messageIn: "[system]", messageOut: "[damage_control_sent]", intent: "DAMAGE_CONTROL" });
  return `\n\n*Damage control for the next 24 hours:*\nNext meal: lean protein + vegetables only — eggs, chicken, or tinned tuna with cabbage or spinach. No carbs for that one meal. Walk 20 minutes today minimum. Water to 2L. One bad meal is nothing. Back on track right now.`;
}

export async function getProgressiveOverloadContext(userId: string): Promise<string> {
  try {
    const recentLifts = await db.select().from(exerciseLogs)
      .where(eq(exerciseLogs.userId, userId))
      .orderBy(desc(exerciseLogs.loggedAt))
      .limit(20);
    if (recentLifts.length === 0) return "";

    // Group by canonical movement (recentLifts is newest-first, so the first entry per
    // key is the most recent). "chest fly" logged today + "pec deck" last week collapse
    // into one tracked lift instead of two dead ones — the point of progressive overload.
    const seen = new Map<string, typeof recentLifts[0]>();
    for (const lift of recentLifts) {
      const key = canonicalLiftKey(lift.exerciseName);
      if (!seen.has(key)) seen.set(key, lift);
    }

    const lines = [...seen.values()]
      // cleanExerciseName tidies names like "my chest fly is" that older parser versions
      // stored verbatim. The WEIGHT is echoed exactly as logged — a heavy machine fly is
      // real, and this is the client's own progressive-overload record.
      .map(lift => ({ lift, name: cleanExerciseName(lift.exerciseName) || lift.exerciseName, w: parseFloat(String(lift.weightKg || 0)) }))
      .slice(0, 6)
      .map(({ lift, name, w }) => {
        const repsStr = lift.sets && lift.reps
          ? ` ${lift.sets}×${lift.reps} reps`
          : lift.reps ? ` ×${lift.reps} reps` : "";
        const nextW = (w + 2.5).toFixed(1).replace(".0", "");
        const daysAgo = Math.floor((Date.now() - new Date(lift.loggedAt || "").getTime()) / 86_400_000);
        const when = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo}d ago`;
        return `• ${name}: ${w}kg${repsStr} (${when}) → aim ${nextW}kg or add 1–2 reps`;
      });

    if (lines.length === 0) return "";
    return `*Your Targets — Based on Last Session:*\n${lines.join("\n")}\n\n`;
  } catch (e) {
    console.warn("[non-fatal]", e);
    return "";
  }
}

export async function checkPerfectDay(userId: string, proteinTarget = 120, stepsTarget = 8500): Promise<string | null> {
  try {
    const todayStart = sastDayStart();

    // "Food tracked" must mean the PROTEIN TARGET was hit, not merely "a food
    // row exists". Before this, checkPerfectDay read chatHistory.FOOD_LOG while
    // the morning scheduler summed mealLogs.proteinInt — so the evening could
    // call "Perfect day! Food tracked" and the morning could call the same
    // user "122g short of your 165g target". Same source of truth now.
    const [todayWorkouts, todaySteps, proteinRow] = await Promise.all([
      db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, userId), gte(workoutLogs.loggedAt, todayStart))).limit(1),
      db.select({ steps: stepLogs.steps }).from(stepLogs).where(and(eq(stepLogs.userId, userId), gte(stepLogs.loggedAt, todayStart))).limit(1),
      db.select({
        totalProt: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
      }).from(mealLogs).where(and(eq(mealLogs.userId, userId), gte(mealLogs.loggedAt, todayStart))),
    ]);

    const totalProt = Number(proteinRow[0]?.totalProt || 0);
    const proteinHit = totalProt >= proteinTarget * 0.9;
    const todayStepCount = todaySteps[0]?.steps ?? 0;
    const stepsHit = todayStepCount >= stepsTarget;

    if (todayWorkouts.length > 0 && stepsHit && proteinHit) {
      return `\n\n🏆 *Perfect day!* Workout done. Steps hit (${todayStepCount.toLocaleString()} / ${stepsTarget.toLocaleString()}). Protein target hit (${totalProt}g / ${proteinTarget}g). This is what transformation looks like — remember how this feels and repeat it tomorrow.`;
    }
    return null;
  } catch (e) {
    console.warn("[checkPerfectDay]", e);
    return null;
  }
}
