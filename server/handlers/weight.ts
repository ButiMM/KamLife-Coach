import { db } from "../db";
import { users, weightLogs } from "../../shared/schema";
import { eq, and, gte, lt, asc, desc } from "drizzle-orm";
import { calculateTargets } from "../targets";
import { storeMemory } from "../memory";

/**
 * Assess whether a weight-change rate is safe, concerning or dangerous for the given goal.
 * Returns null when there's not enough data or the change is negligible.
 *
 * Safe bands expressed as % of current bodyweight per week (scales correctly for all sizes):
 *  fat_loss:    0–0.5% BW excellent, 0.5–1% ok, 1–1.5% warn, 1.5–2% alert, >2% danger
 *  recomposition: 0–0.4% BW fine, 0.4–0.75% warn, >0.75% alert
 *  muscle_gain: should be gaining or flat; any consistent loss is a problem
 */
export function assessWeightRate(
  totalChangeKg: number,
  weeksSinceStart: number,
  goal: string,
  proteinTarget: number,
  calorieTarget: number,
  name: string,
  currentWeightKg: number,
): string | null {
  if (weeksSinceStart < 1 || Math.abs(totalChangeKg) < 0.3) return null;
  const pace = Math.abs(totalChangeKg) / weeksSinceStart;
  const nm = name ? `${name}, ` : "";

  if (totalChangeKg < 0 && (goal === "fat_loss" || goal === "recomposition")) {
    // Bands expressed as % of current bodyweight per week — correct for all body sizes.
    // 0.5–1% BW/week is the evidence-based fat loss target (TBD; Helms et al.).
    const excellentBand = goal === "fat_loss" ? currentWeightKg * 0.005 : currentWeightKg * 0.004;
    const maxSafe      = goal === "fat_loss" ? currentWeightKg * 0.01  : currentWeightKg * 0.0075;
    const maxWarn      = goal === "fat_loss" ? currentWeightKg * 0.015 : currentWeightKg * 0.0075;
    const dangerBand   = currentWeightKg * 0.02;
    if (pace <= excellentBand) {
      return `📉 Total lost: *${Math.abs(totalChangeKg).toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — ✅ right on target, sustainable.`;
    } else if (pace <= maxSafe) {
      return `📉 Total lost: *${Math.abs(totalChangeKg).toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — ✅ good, at the high end of safe. Keep protein at ${proteinTarget}g daily.`;
    } else if (pace <= maxWarn) {
      return `📉 Total lost: *${Math.abs(totalChangeKg).toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — ⚠️ *faster than ideal.* At this pace you're likely losing muscle alongside fat. Hit ${proteinTarget}g protein every single day — that's what protects your muscle while you lose fat.`;
    } else if (pace <= dangerBand) {
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
  const prevCals = user.calorieTarget || newCals;
  const prevProtein = user.proteinTarget || newProtein;

  const todayWeightStart = sastDayStart();
  // The true "last log" for the change comparison is the most recent weigh-in BEFORE today —
  // NOT user.currentWeight, which can still hold a stale onboarding number and produced the
  // nonsense "up 15.8kg from last log" when a client first weighed in on the system.
  // Read this baseline BEFORE writing today's row (filtered to < today, so the write can't move it).
  const [lastPriorLog] = await db.select({ weight: weightLogs.weight })
    .from(weightLogs)
    .where(and(eq(weightLogs.userId, user.id), lt(weightLogs.loggedAt, todayWeightStart)))
    .orderBy(desc(weightLogs.loggedAt))
    .limit(1);
  const lastLoggedKg = lastPriorLog ? parseFloat(String(lastPriorLog.weight)) : null;

  // Atomic: the user's targets and today's weigh-in must both land or neither. A half-commit
  // (targets updated but no weight row, or a weight row with stale targets) corrupts every
  // downstream comparison and the auto-calorie-adjust job. Wrap both writes in one transaction.
  await db.transaction(async (tx) => {
    await tx.update(users)
      .set({ currentWeight: newKg.toString(), calorieTarget: newCals, proteinTarget: newProtein })
      .where(eq(users.phoneNumber, phone));

    const existingToday = await tx.select({ id: weightLogs.id }).from(weightLogs)
      .where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, todayWeightStart)))
      .limit(1);
    if (existingToday.length > 0) {
      await tx.update(weightLogs).set({ weight: newKg.toString() }).where(eq(weightLogs.id, existingToday[0].id));
    } else {
      await tx.insert(weightLogs).values({ userId: user.id, weight: newKg.toString() });
    }
  });

  // True journey start = the FIRST weight ever logged (now includes today's row if it's the first).
  // Used by BOTH the milestone and goal-reached voice scripts so neither ever quotes last week's
  // weight as the starting point. prevKg (user.currentWeight before this log) is the PREVIOUS
  // weigh-in, not the journey start — passing it as startKg was the goal-voice bug.
  const [journeyFirstLog] = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt })
    .from(weightLogs).where(eq(weightLogs.userId, user.id))
    .orderBy(asc(weightLogs.loggedAt)).limit(1);
  const journeyStartKg = journeyFirstLog ? parseFloat(String(journeyFirstLog.weight)) : newKg;

  let milestoneCelebration = "";
  try {
    const startKg = journeyStartKg;
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
          .then(({ script, emotion }) => generateVoiceNote(script, emotion))
          .then(url => { if (url) return sendWhatsApp(phone, "", url); })
          .catch(err => console.warn("[TTS] Milestone voice failed:", err));
        break;
      }
    }
  } catch (e) { console.warn("[non-fatal]", e); }

  // Compare against the genuine previous weigh-in. On the very first log there is no
  // prior entry, so we say nothing rather than inventing a change off a stale baseline.
  let changeNote = "";
  if (lastLoggedKg !== null && Math.abs(newKg - lastLoggedKg) > 0.1) {
    const diff = newKg - lastLoggedKg;
    const direction = diff < 0 ? `⬇️ down ${Math.abs(diff).toFixed(1)}kg` : `⬆️ up ${diff.toFixed(1)}kg`;
    changeNote = ` ${direction} from last log.`;
  }

  let journeyNote = "";
  try {
    if (journeyFirstLog) {
      const startKg = journeyStartKg;
      const totalChange = newKg - startKg;
      const weeksSinceStart = Math.max(1, (Date.now() - new Date(journeyFirstLog.loggedAt!).getTime()) / (7 * 86_400_000));
      const firstName = (user.name || "").split(" ")[0] || "";
      const rateNote = assessWeightRate(totalChange, weeksSinceStart, user.goalType || "fat_loss", newProtein, newCals, firstName, newKg);
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
      // startKg must be the journey start (first weigh-in), not prevKg (last week's weight),
      // or the voice note tells the client they "started at" a weight from days ago.
      const kgLostTotal = journeyStartKg - newKg;
      generateMilestoneVoiceScript(user, goalMilestone, { currentKg: newKg, startKg: journeyStartKg, kgLost: Math.max(0, kgLostTotal) })
        .then(({ script, emotion }) => generateVoiceNote(script, emotion))
        .then(url => { if (url) return sendWhatsApp(phone, "", url); })
        .catch(err => console.warn("[TTS] Goal voice failed:", err));
      return `🏆 *GOAL REACHED.*\n\nWeight logged: *${newKg}kg.*${changeNote}\n\n${firstName}, you hit your target of ${targetKg}kg. This is real — you did the work.\n\nNow we need a new direction. Reply with a number:\n\n*1* — Maintain this weight\n*2* — Build muscle\n*3* — Recomposition (hold weight, swap fat for muscle)\n\nWhat's next?`;
    }
  }

  const threeWeeksAgo = new Date(Date.now() - 21 * 86_400_000);
  const sevenDaysAgo  = new Date(Date.now() -  7 * 86_400_000);
  const recentWeightLogs = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt })
    .from(weightLogs).where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, threeWeeksAgo)))
    .orderBy(asc(weightLogs.loggedAt));
  let plateauNote = "";
  // Compare 7-day rolling averages instead of single weigh-ins — eliminates daily water-weight noise.
  const last7  = recentWeightLogs.filter(r => new Date(r.loggedAt!).getTime() >= sevenDaysAgo.getTime());
  const older  = recentWeightLogs.filter(r => new Date(r.loggedAt!).getTime() <  sevenDaysAgo.getTime());
  if (last7.length >= 3 && older.length >= 3) {
    const avg7     = last7.reduce((s, r)  => s + parseFloat(String(r.weight)), 0) / last7.length;
    const avgOlder = older.reduce((s, r)  => s + parseFloat(String(r.weight)), 0) / older.length;
    if (Math.abs(avg7 - avgOlder) < 0.5) {
      plateauNote = `\n\n7-day average has not moved in 3 weeks. Your body has adapted — this is normal, not failure. Options: tighten portions slightly, add a 20-minute daily walk, or take a 1–2 week diet break at maintenance. Pick one and commit for a week.`;
    }
  }

  return `Weight logged: *${newKg}kg.*${changeNote}${milestoneCelebration || journeyNote}${targetsNote}${plateauNote}`;
}
