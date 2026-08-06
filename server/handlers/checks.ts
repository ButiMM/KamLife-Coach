import { db } from "../db";
import { chatHistory, mealLogs, workoutLogs, stepLogs, exerciseLogs, users } from "../../shared/schema";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { sastDayStart } from "../utils";
import { cleanExerciseName, canonicalLiftKey } from "../programme";
import { adaptTraining, trainingStateFromUser, type TrainingInput } from "../adaptive-training";

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

/**
 * @param compact ONE SENTENCE, TOP LIFT ONLY (2026-08-06). The done-confirmation used to staple
 *        the whole six-line target table onto a reply that was already a wall, and a client who
 *        has just walked out of the gym does not read a table — they read the first line and the
 *        buttons. The full list still belongs on "today's workout", where they ASKED for it.
 */
export async function getProgressiveOverloadContext(userId: string, opts: { compact?: boolean } = {}): Promise<string> {
  try {
    // ASK THE OWNER WHAT TODAY'S LOAD IS (2026-07-30). This block used to print "→ aim 127.5kg"
    // straight off the last session while the header two lines above said "start at 60% of your
    // old weights" — both in one message, to a man 21 days into a layoff. Progressive overload is
    // only the right instruction for someone who is actually progressing.
    const [u] = await db.select({
      profileNotes: users.profileNotes, lastWorkoutDate: users.lastWorkoutDate,
    }).from(users).where(eq(users.id, userId)).limit(1);
    const adjust = u ? adaptTraining(trainingStateFromUser(u) as TrainingInput) : null;
    const heldBack = !!adjust && adjust.loadPct < 100;

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

    const ranked = [...seen.values()]
      // cleanExerciseName tidies names like "my chest fly is" that older parser versions
      // stored verbatim. The WEIGHT is echoed exactly as logged — a heavy machine fly is
      // real, and this is the client's own progressive-overload record.
      .map(lift => ({ lift, name: cleanExerciseName(lift.exerciseName) || lift.exerciseName, w: parseFloat(String(lift.weightKg || 0)) }));

    // COMPACT: the single most recent lift, as one sentence a person actually reads.
    if (opts.compact) {
      const top = ranked[0];
      if (!top || !(top.w > 0)) return "";
      if (heldBack && adjust) {
        const todayW = Math.round((top.w * adjust.loadPct) / 100 * 2) / 2;
        return `Last ${top.name} was ${top.w}kg — keep it to ${todayW}kg today while you ease back in.`;
      }
      const nextW = (top.w + 2.5).toFixed(1).replace(".0", "");
      return `Last ${top.name} was ${top.w}kg — go for ${nextW}kg or an extra rep or two.`;
    }

    const lines = ranked
      .slice(0, 6)
      .map(({ lift, name, w }) => {
        const repsStr = lift.sets && lift.reps
          ? ` ${lift.sets}×${lift.reps} reps`
          : lift.reps ? ` ×${lift.reps} reps` : "";
        const daysAgo = Math.floor((Date.now() - new Date(lift.loggedAt || "").getTime()) / 86_400_000);
        const when = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo}d ago`;
        if (heldBack && adjust) {
          const todayW = Math.round((w * adjust.loadPct) / 100 * 2) / 2; // nearest 0.5kg
          return `• ${name}: ${w}kg${repsStr} (${when}) → today ${todayW}kg (${adjust.loadPct}%)`;
        }
        const nextW = (w + 2.5).toFixed(1).replace(".0", "");
        return `• ${name}: ${w}kg${repsStr} (${when}) → aim ${nextW}kg or add 1–2 reps`;
      });

    if (lines.length === 0) return "";
    const head = heldBack
      ? "*Your Lifts — eased back for today:*"
      : "*Your Targets — Based on Last Session:*";
    return `${head}\n${lines.join("\n")}\n\n`;
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
      // ONE LINE, NO SCOREBOARD (2026-08-06). This used to read back three ratios — steps
      // 8,712/8,500, protein 141g/130g — which is a receipt for a day they just lived. They
      // know they hit it. Saying it well beats saying it twice with the maths attached.
      return ` 🏆 And that's a perfect day — training, steps and protein all hit.`;
    }
    return null;
  } catch (e) {
    console.warn("[checkPerfectDay]", e);
    return null;
  }
}
