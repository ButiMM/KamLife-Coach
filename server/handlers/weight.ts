import { db } from "../db";
import { turnMutation, turnEvidence } from "./chat-log";
import { users, weightLogs, escalations } from "../../shared/schema";
import { neverSilentLine } from "../reply-hygiene";
import { trendCalorieAdjust } from "../adaptive-targets";
import { escalationSLA } from "../safety-detection";
import { eq, and, gte, lt, asc, desc } from "drizzle-orm";
import { calculateTargets } from "../targets";
import { storeMemory } from "../memory";
import { invalidatePatternCache } from "../cache";

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
  // Muscle-gain clients often dip in the first 1-2 weeks (glycogen, water, adaptation).
  // Don't fire the 🚨 alert until the pattern is established: ≥2 weeks AND ≥0.5kg loss.
  // Before that it's noise, not a trend — alarming early destroys motivation without cause.
  if (goal === "muscle_gain" && totalChangeKg < 0 && (weeksSinceStart < 2 || Math.abs(totalChangeKg) < 0.5)) return null;
  const pace = Math.abs(totalChangeKg) / weeksSinceStart;
  const nm = name ? `${name}, ` : "";

  if (totalChangeKg < 0 && (goal === "fat_loss" || goal === "recomposition")) {
    // Bands expressed as % of current bodyweight per week — correct for all body sizes.
    // 0.5–1% BW/week is the evidence-based fat loss target (TBD; Helms et al.).
    const excellentBand = goal === "fat_loss" ? currentWeightKg * 0.005 : currentWeightKg * 0.004;
    // recomposition has no separate "high end of safe" tier — per the band spec above,
    // 0.4–0.75%/wk is the WARN tier. maxSafe collapses to the excellent boundary so the
    // 0.4–0.75% range falls through to the ⚠️ "faster than ideal" branch instead of being
    // mislabelled "good" (and the warn branch being unreachable dead code).
    const maxSafe      = goal === "fat_loss" ? currentWeightKg * 0.01  : currentWeightKg * 0.004;
    const maxWarn      = goal === "fat_loss" ? currentWeightKg * 0.015 : currentWeightKg * 0.0075;
    const dangerBand   = currentWeightKg * 0.02;
    if (pace <= excellentBand) {
      return `📉 Total lost: *${Math.abs(totalChangeKg).toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — ✅ right on target, sustainable.`;
    } else if (pace <= maxSafe) {
      return `📉 Total lost: *${Math.abs(totalChangeKg).toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — ✅ good, at the high end of safe. Keep protein at ${proteinTarget}g daily.`;
    } else if (pace <= maxWarn) {
      return `📉 Total lost: *${Math.abs(totalChangeKg).toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — ⚠️ *faster than ideal.* At this pace you're likely losing muscle alongside fat. Hit ${proteinTarget}g protein every single day — that's what protects your muscle while you lose fat.`;
    } else if (pace <= dangerBand) {
      return `📉 Total lost: *${Math.abs(totalChangeKg).toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — 🚨 *this is too fast.* Losing this quickly burns muscle, slows down how much your body burns, and the weight usually piles back on. Add 200 kcal/day and hit ${proteinTarget}g protein. Your target is ${calorieTarget} kcal — are you reaching it?`;
    } else {
      return `⚠️ *${nm}you're losing very fast — ${pace.toFixed(2)}kg a week.* Dropping this quickly can burn muscle and slow your metabolism, and it usually means you're not eating enough. Can you tell me what a normal day's food looks like for you? Let's make sure you're eating enough to do this safely.`;
    }
  }

  if (totalChangeKg < 0 && goal === "muscle_gain") {
    return pace > 0.3
      ? `🚨 *${nm}you're losing weight on a muscle-building programme.* Down ${Math.abs(totalChangeKg).toFixed(1)}kg — you can't build muscle while eating less than your body burns. You need to eat MORE: push to ${calorieTarget} kcal and ${proteinTarget}g protein every day. What's your typical day of eating look like?`
      : `⚠️ Down *${Math.abs(totalChangeKg).toFixed(1)}kg* on a muscle gain programme. You need to eat a bit more than your body burns — are you hitting ${calorieTarget} kcal daily?`;
  }

  if (totalChangeKg > 0 && goal === "muscle_gain") {
    if (pace >= 0.1 && pace <= 0.5) return `📈 Total gained: *${totalChangeKg.toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — ✅ solid lean gain rate.`;
    if (pace > 0.5) return `📈 Total gained: *${totalChangeKg.toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — gaining fast, watch body fat levels.`;
    return `📈 Total gained: *${totalChangeKg.toFixed(1)}kg*. Pace: ${pace.toFixed(2)}kg/week — very slow. Push calories up slightly.`;
  }

  if (totalChangeKg > 0 && goal === "fat_loss") {
    return `📈 Up *${totalChangeKg.toFixed(1)}kg* since starting. Could be water or sodium — weigh again tomorrow morning, same conditions. If the trend holds, let's look at your food together.`;
  }

  return `${totalChangeKg < 0 ? "📉" : "📈"} Total change: *${totalChangeKg > 0 ? "+" : ""}${totalChangeKg.toFixed(1)}kg*.`;
}

/**
 * Least-squares weekly trend slope (kg/week) over a set of weigh-ins.
 * Uses EVERY point, not just the endpoints, so one noisy reading (water, sodium, time of
 * day) can't fabricate a "gaining fast"/"losing fast" signal the way a 2-point slope does.
 * Returns null when there are too few points or too short a span to mean anything.
 */
export function weeklyTrendSlopeKg(
  points: { dayOffset: number; kg: number }[],
  minPoints = 3,
  minSpanDays = 5,
): number | null {
  if (points.length < minPoints) return null;
  const xs = points.map(p => p.dayOffset);
  const span = Math.max(...xs) - Math.min(...xs);
  if (span < minSpanDays) return null;
  const n = points.length;
  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.kg, 0) / n;
  let num = 0, den = 0;
  for (const p of points) {
    num += (p.dayOffset - meanX) * (p.kg - meanY);
    den += (p.dayOffset - meanX) ** 2;
  }
  if (den === 0) return null;
  return (num / den) * 7;
}

import { sastDayStart } from "../utils";
import { generateVoiceNote } from "../tts";
import { sendWhatsApp } from "../scheduler/shared";
import { generateMilestoneVoiceScript } from "../gpt";

export async function handleWeightLog(
  phone: string,
  user: any,
  newKg: number,
  options: { suppressCustomerLifecycle?: boolean } = {},
): Promise<string> {
  if (!Number.isFinite(newKg) || newKg < 30 || newKg > 250) {
    return `That weight reads as *${newKg}kg* — that doesn't look right. Send your weight again as just a number followed by kg, like "82kg" or "76.5kg".`;
  }

  // UNDERWEIGHT GATE (weigh-in side): if the scale drops under BMI 18.5 while the
  // goal is fat loss, flip to building — mirrors the onboarding gate (duty of care;
  // the auto-adjust engine must never keep deepening a deficit under the healthy range).
  let underweightFlipNote = "";
  const bmiNow = (user.heightCm || 0) > 0 ? newKg / Math.pow((user.heightCm || 170) / 100, 2) : 0;
  if ((user.goalType || "fat_loss") === "fat_loss" && bmiNow > 0 && bmiNow < 18.5) {
    user.goalType = "muscle_gain";
    underweightFlipNote = `\n\n⚠️ At ${newKg}kg you're under the healthy weight range — I've switched your plan to *building* (strength + fuel + protein). I won't coach further weight loss from here. If a doctor or dietitian is part of your picture, loop them in.`;
    db.insert(escalations).values({ userId: user.id, reason: "underweight_fatloss_weighin", triggerMessage: `BMI ${bmiNow.toFixed(1)} (${newKg}kg) on fat_loss at weigh-in — auto-flipped to muscle_gain`, priority: "high", slaDeadline: escalationSLA("high") }).catch((e) => console.error("[UNDERWEIGHT_GATE:weighin]", e));
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
      .set({ currentWeight: newKg.toString(), calorieTarget: newCals, proteinTarget: newProtein, goalType: user.goalType })
      .where(eq(users.phoneNumber, phone));

    // `weight` comes back beside `id` so the correction can say what it replaced. Same query,
    // one more column — the turn note below is the only consumer.
    const existingToday = await tx.select({ id: weightLogs.id, weight: weightLogs.weight }).from(weightLogs)
      .where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, todayWeightStart)))
      .limit(1);
    if (existingToday.length > 0) {
      await tx.update(weightLogs).set({ weight: newKg.toString() }).where(eq(weightLogs.id, existingToday[0].id));
      /**
       * A SECOND WEIGH-IN TODAY IS STILL A DURABLE WRITE (#114 P0-2, 2026-09-03).
       *
       * This branch has always corrected the row — that part was never broken. What it did not do
       * was TELL THE TURN, because turnMutation sat only in the insert branch below. So a client
       * correcting 84.0 to 83.4 changed the ledger while the turn recorded `mutations: null`, and
       * every reader of that record was then working from "this turn wrote nothing":
       *
       *   • turnAlreadyWrote("weight") stayed false, so a second door could write the day again;
       *   • routes' `wroteThisTurn` stayed false, so claimants that must stand down after a write
       *     did not stand down;
       *   • the workout owner logged "weight stated and not yet written" — a decision made on a
       *     false premise, and the line that first made this look like a lost correction;
       *   • Coach Health reads `mutations`, so LAW 4 could never see a same-day weigh-in at all.
       *
       * The write and the record of the write are one fact. Worded UPDATE-with-was, matching the
       * steps owner, so a reader can tell a correction from a first weigh-in.
       *
       * ONLY WHEN THE DAY ACTUALLY MOVED. `mutations` is operational state — claimant stand-down
       * and Coach Health both consume it — not logging, so a semantic no-op must not enter it. A
       * client repeating today's 84kg has changed nothing about the day, and recording a durable
       * write for it would stand claimants down and hand Coach Health a weigh-in that did not
       * happen. The SQL is left alone: the row is still set to the same value, which is what it
       * already held, and narrowing the write is a separate question from narrowing the record.
       *
       * A stored value that will not parse is the exception — then this update is a repair and
       * genuinely changes the day, so it is recorded (without a "was" it cannot honestly state).
       */
      const wasKg = parseFloat(String(existingToday[0].weight ?? ""));
      const unusable = !Number.isFinite(wasKg);
      if (unusable || wasKg !== newKg) {
        turnMutation(
          unusable ? `UPDATE weight=${newKg}kg` : `UPDATE weight=${newKg}kg (was ${wasKg}kg)`,
          "[WEIGHT_LOG]",
        );
      }
    } else {
      await tx.insert(weightLogs).values({ userId: user.id, weight: newKg.toString() });
      turnMutation(`INSERT weight=${newKg}kg`, "[WEIGHT_LOG]");
    }
  });
  // Keep the caller's turn-local profile coherent with the durable truth this owner just wrote.
  // The normalizer can capture weight before later goal handling in the same turn; leaving this
  // object stale would make that downstream calculation use yesterday's weight.
  user.currentWeight = newKg.toString();
  user.calorieTarget = newCals;
  user.proteinTarget = newProtein;
  // The cached pattern summary feeds every GPT reply for up to an hour — without this,
  // the coach can contradict the weigh-in the client JUST sent ("no weight data this week").
  invalidatePatternCache(user.id);

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
      if (!options.suppressCustomerLifecycle && totalLoss >= milestone && totalLoss < milestone + 0.6) {
        await storeMemory(phone, `Weight loss milestone: lost ${milestone}kg total — started at ${startKg}kg, now at ${newKg}kg`, "milestone");
        milestoneCelebration = MILESTONE_MESSAGES[milestone] || "";
        generateMilestoneVoiceScript(user, "weight_loss", { kgLost: milestone, currentKg: newKg, startKg })
          .then(({ script, emotion }) => generateVoiceNote(script, emotion, user.id))
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
  if (!options.suppressCustomerLifecycle && targetKg > 0) {
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
        .then(({ script, emotion }) => generateVoiceNote(script, emotion, user.id))
        .then(url => { if (url) return sendWhatsApp(phone, "", url); })
        .catch(err => console.warn("[TTS] Goal voice failed:", err));
      // The biggest moment in the product gets ONE celebration and ONE question (2026-08-06
      // sweep). It used to be ten lines with a numbered menu underneath — a form to fill in at
      // the exact moment a person wants to be told they did it.
      return `🏆 ${firstName}, you hit ${targetKg}kg — that's the goal, done. Real work.\n\nWhere to now?[BUTTONS:Maintain this|Build muscle|Recomposition]`;
    }
  }

  // ── 4-week history for trend analysis, plateau detection, streak count ──
  const fourWeeksAgo = new Date(Date.now() - 28 * 86_400_000);
  const sevenDaysAgo = new Date(Date.now() -  7 * 86_400_000);
  const recentWeightLogs = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt })
    .from(weightLogs).where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, fourWeeksAgo)))
    .orderBy(asc(weightLogs.loggedAt));

  // ── Consecutive weigh-in streak (counts today) ──
  let weighInStreak = 0;
  {
    const allRecentDays = new Set(recentWeightLogs.map(r => {
      const d = new Date(new Date(r.loggedAt!).getTime() + 2 * 3_600_000); // SAST
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
    }));
    const check = new Date(Date.now() + 2 * 3_600_000);
    while (true) {
      const key = `${check.getUTCFullYear()}-${String(check.getUTCMonth()+1).padStart(2,"0")}-${String(check.getUTCDate()).padStart(2,"0")}`;
      if (!allRecentDays.has(key)) break;
      weighInStreak++;
      check.setUTCDate(check.getUTCDate() - 1);
    }
  }

  // ── Recent trend: rate over the last 14 days ──
  // Use the oldest point in the 14-day window as the baseline. This is more meaningful than the
  // all-time average because it reflects what the body is doing RIGHT NOW.
  const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000);
  const recentWindow = recentWeightLogs.filter(r => new Date(r.loggedAt!).getTime() >= twoWeeksAgo.getTime());
  // Least-squares slope over EVERY point in the window — replaces the old 2-point (oldest
  // vs newest) slope, which let a single noisy reading fabricate a trend and drive a
  // calorie change off water weight.
  const trendPoints = recentWindow.map(r => ({
    dayOffset: new Date(r.loggedAt!).getTime() / 86_400_000,
    kg: parseFloat(String(r.weight)),
  }));
  const recentSpanDays = trendPoints.length >= 2
    ? Math.max(...trendPoints.map(p => p.dayOffset)) - Math.min(...trendPoints.map(p => p.dayOffset))
    : 0;
  const recentRateKgPerWeek = weeklyTrendSlopeKg(trendPoints, 3, 5);

  // ── Trend-based calorie adjustment ──
  // Standard targets from calculateTargets are a good baseline but don't account for the actual
  // trajectory. If the client is losing too fast or too slow, adjust accordingly.
  let finalCals = newCals;
  let finalProtein = newProtein;
  let calAdjust = 0;
  let trendLabel = "";
  let trendStatus = "";

  if (recentRateKgPerWeek !== null) {
    const rate = recentRateKgPerWeek;
    const rateStr = `${rate >= 0 ? "+" : ""}${rate.toFixed(2)}kg/week`;
    // Judge the pace by % of BODY WEIGHT per week, not raw kg (2026-07-12, Kam: be
    // precise for obese clients). 0.85kg/week is "too fast" for a 70kg person (1.2%) but
    // a perfectly safe pace for a 130kg client (0.65%) — the same kg threshold wrongly
    // told the heavy client to eat more and the light client they were fine. The kg
    // figure is still SHOWN (clients think in kg); only the decision scales with weight.
    const ratePct = (rate / (newKg > 0 ? newKg : 85)) * 100;

    if (goal === "fat_loss") {
      // Ideal: ~0.25–0.85% of bodyweight per week.
      if (ratePct < -1.0) {
        calAdjust = trendCalorieAdjust(goal, ratePct);
        trendLabel = `📉 *${rateStr} over 2 weeks*`;
        trendStatus = `⚠️ too fast for your body weight — you'll lose muscle alongside fat. Adding 150 kcal to protect your muscle.`;
      } else if (ratePct < -0.88) {
        calAdjust = trendCalorieAdjust(goal, ratePct);
        trendLabel = `📉 *${rateStr} over 2 weeks*`;
        trendStatus = `at the aggressive end. Adding 100 kcal — sustainable pace matters more than speed.`;
      } else if (ratePct <= -0.24) {
        calAdjust = trendCalorieAdjust(goal, ratePct);
        trendLabel = `📉 *${rateStr} over 2 weeks*`;
        trendStatus = `✅ right on target. Keep going.`;
      } else if (ratePct < 0) {
        calAdjust = trendCalorieAdjust(goal, ratePct);
        trendLabel = `📉 *${rateStr} over 2 weeks*`;
        trendStatus = `slower than ideal. Removing 100 kcal to get progress moving.`;
      } else {
        calAdjust = trendCalorieAdjust(goal, ratePct);
        trendLabel = `📈 *${rateStr} over 2 weeks*`;
        trendStatus = `weight is going up on a fat loss programme. Removing 150 kcal and review your food log.`;
      }
    } else if (goal === "muscle_gain") {
      // Ideal: ~0.1–0.45% of bodyweight per week (any faster is mostly fat).
      if (ratePct > 0.55) {
        calAdjust = trendCalorieAdjust(goal, ratePct);
        trendLabel = `📈 *${rateStr} over 2 weeks*`;
        trendStatus = `gaining fast for your body weight — some of that will be fat. Pulling back 100 kcal to keep it lean.`;
      } else if (ratePct >= 0.1) {
        calAdjust = trendCalorieAdjust(goal, ratePct);
        trendLabel = `📈 *${rateStr} over 2 weeks*`;
        trendStatus = `✅ ideal lean gain pace. Stay exactly here.`;
      } else if (ratePct > -0.12) {
        calAdjust = trendCalorieAdjust(goal, ratePct);
        trendLabel = `➡️ *${rateStr} over 2 weeks*`;
        trendStatus = `scale isn't moving — to grow you need to eat a bit more than your body burns. Adding 100 kcal.`;
      } else {
        calAdjust = trendCalorieAdjust(goal, ratePct);
        trendLabel = `📉 *${rateStr} over 2 weeks*`;
        trendStatus = `losing weight on a muscle gain programme. Adding 150 kcal — you need to eat a bit more than you burn to build.`;
      }
    } else if (goal === "recomposition") {
      trendLabel = `➡️ *${rateStr} over 2 weeks*`;
      if (Math.abs(ratePct) <= 0.35) {
        trendStatus = `✅ scale is stable while body composition is shifting. Exactly right.`;
      } else if (ratePct < -0.35) {
        trendStatus = `dropping a bit fast for recomp. Make sure you're hitting your calorie target each day.`;
      } else {
        trendStatus = `slight upward drift. Tighten carbs on rest days.`;
      }
    }

    // Only MOVE calories on a solid trend: ≥4 weigh-ins spanning ≥10 days, AND the most
    // recent reading must not contradict the fortnight trend. A single weigh-in pointing
    // the other way is noise — show the trend and explain, but never cut/add off it.
    const lastLogDelta = lastLoggedKg !== null ? newKg - lastLoggedKg : null;
    const latestContradictsTrend = lastLogDelta !== null && recentRateKgPerWeek !== null
      && Math.abs(lastLogDelta) >= 0.2
      && Math.sign(lastLogDelta) !== Math.sign(recentRateKgPerWeek);
    const enoughForCalChange = recentWindow.length >= 4 && recentSpanDays >= 10;

    if (calAdjust !== 0 && enoughForCalChange && !latestContradictsTrend) {
      // AUTO-ADJUST RE-ENABLED (2026-08-05) — its gate was an audit, and the audit passed.
      //
      // Disabled this morning because it silently CHANGES a client's calories while multiplying
      // a maintenance figure we had just found wrong by ~380 kcal. Both conditions are cleared:
      // the base is corrected, and the decision is extracted into trendCalorieAdjust() with six
      // assertions on it — contiguous bands, bounded to +/-150, a wide dead band on the ideal
      // pace, corrections that move TOWARD that band, and no oscillation.
      //
      // The no-oscillation proof is the one that mattered: a max correction is 150 kcal/day
      // ~= 0.14kg/week, a fraction of the dead band's width at every body weight tested. One
      // correction cannot carry a client across the neutral zone and back. It also cannot
      // compound — it is applied to a FRESHLY COMPUTED target each weigh-in, never to the
      // previous adjusted value.
      //
      // The audit found a live defect while proving this: a non-finite rate coerced to 0, which
      // on a fat-loss plan read as "gaining" and quietly removed 150 kcal. Fixed.
      //
      // Still gated on the guards above — 4+ weigh-ins over 10+ days, latest reading must not
      // contradict the fortnight trend. TREND_AUTOADJUST=off is the revert.
      if (process.env.TREND_AUTOADJUST !== "off") {
        finalCals = Math.max(1200, Math.min(4000, newCals + calAdjust));
      } else {
        calAdjust = 0;
      }
      await db.update(users).set({ calorieTarget: finalCals }).where(eq(users.phoneNumber, phone));
    } else if (calAdjust !== 0) {
      // We see a direction but won't act on thin or self-contradictory data — keep targets,
      // explain why, so the message stays coherent instead of "down 0.3kg" + "cutting 100 kcal".
      calAdjust = 0;
      trendStatus = latestContradictsTrend
        ? `your last reading moved the other way — one weigh-in is noise, so I'm watching the trend, not changing your targets yet.`
        : `I want a few more weigh-ins (daily is best) before I change your targets — keeps the call based on signal, not water weight.`;
    }
  }

  // ── Plateau detection (3-week rolling averages) ──
  let plateauNote = "";
  const last7Logs = recentWeightLogs.filter(r => new Date(r.loggedAt!).getTime() >= sevenDaysAgo.getTime());
  const olderLogs = recentWeightLogs.filter(r => new Date(r.loggedAt!).getTime() <  sevenDaysAgo.getTime());
  if (last7Logs.length >= 3 && olderLogs.length >= 3) {
    const avg7     = last7Logs.reduce((s, r) => s + parseFloat(String(r.weight)), 0) / last7Logs.length;
    const avgOlder = olderLogs.reduce((s, r) => s + parseFloat(String(r.weight)), 0) / olderLogs.length;
    if (Math.abs(avg7 - avgOlder) < 0.4 && !trendStatus.includes("✅")) {
      plateauNote = `\n\n_Your 3-week average hasn't moved — that's your body adapting, not you failing. Totally normal, especially once you've already lost a good amount. Best move: a *diet break* — eat at the level where your weight holds steady for 1 week. It feels backwards, but it resets your metabolism and hormones and the loss restarts after. It's a strategy, not a slip. (Or: slightly smaller portions, or a 20-min daily walk — pick one, commit for a week.)_`;
    }
  }

  // ── Prediction to goal ──
  let predictionNote = "";
  const targetKgRaw = parseFloat(user.targetWeightKg || "0");
  if (targetKgRaw > 0 && recentRateKgPerWeek !== null && Math.abs(recentRateKgPerWeek) >= 0.05) {
    const remaining = targetKgRaw - newKg;
    const weeksToGoal = remaining / recentRateKgPerWeek;
    if (weeksToGoal > 0 && weeksToGoal < 104) {
      const wks = Math.round(weeksToGoal);
      const eta = new Date(Date.now() + weeksToGoal * 7 * 86_400_000);
      const monthName = eta.toLocaleString("en-ZA", { month: "long" });
      predictionNote = `\n_At this pace: ${Math.abs(remaining).toFixed(1)}kg to go — ~${wks} week${wks !== 1 ? "s" : ""} (around ${monthName})._`;
    }
  }

  // ── Streak acknowledgment ──
  let streakNote = "";
  if (weighInStreak >= 14) {
    streakNote = `\n_${weighInStreak} consecutive weigh-ins. This data is reliable because of your consistency._`;
  } else if (weighInStreak >= 7) {
    streakNote = `\n_${weighInStreak} days of daily weigh-ins — the trend is accurate._`;
  }

  // ── Targets line ──
  const calChanged = Math.abs(finalCals - prevCals) > 20 || Math.abs(finalProtein - prevProtein) > 2;
  const adjustNote = calAdjust !== 0 ? ` (${calAdjust > 0 ? "+" : ""}${calAdjust} kcal — ${trendStatus.replace(/[✅⚠️🚨]/g, "").trim()})` : "";
  const targetsLine = calChanged
    ? `\n\n*Targets updated: ${finalCals} kcal/day | ${finalProtein}g protein.*${adjustNote}\n\n_These replace your old numbers — your body changed, so the plan changed with it. A saved plan goes stale within a week; keeping it current is the actual work._`
    : `\n\nTargets: ${finalCals} kcal/day | ${finalProtein}g protein.`;

  // ── Trend line (only when we have recent data) ──
  const trendLine = trendLabel ? `\n\n${trendLabel} — ${trendStatus}` : (milestoneCelebration ? "" : journeyNote);

  // ONE add-on per reply (2026-07-10 friction audit). DATA always stays: the change,
  // the trend, a target adjustment (transaction record), the underweight safety note.
  // Then ONE extra rides along: milestone > plateau (actionable) > prediction > streak.
  const weightAddOn = [milestoneCelebration, plateauNote, predictionNote, streakNote]
    .find(s => s && s.trim()) || "";

  // DELETED 2026-08-04 (Slice 4). This returned, on every weigh-in: "Weight logged: *83kg.*",
  // a change note, a trend label, a targets block naming two figures the client never asked
  // for, an italic paragraph explaining why their plan changed, one of four add-ons, and a
  // button menu. A person stood on a scale and got a printout.
  //
  // THE SAFETY NOTE IS THE ONE THING THAT STILL SPEAKS. underweightFlipNote is a duty-of-care
  // message — it fires when a client is under a healthy BMI and the plan has been flipped to
  // building UP. That is not coaching voice, it is the same class as the crisis routing, and
  // it must reach the person whether or not the engine wrote anything. Everything else that
  // used to be concatenated here is now the coach's job, or the card's.
  void changeNote; void trendLine; void targetsLine; void weightAddOn;
  // THE RECEIPT, RECORDED FOR THE DURABLE-LOG CLOSE (#207) — see steps.ts. The safety note is
  // deliberately NOT part of it: a turn carrying duty-of-care prose is not a bare receipt, so the
  // string will not match and the existing append path runs, exactly as it does today.
  const amount = `${newKg}kg`;
  const line = neverSilentLine("weight", { amount });
  turnEvidence({ receipt: { line, kind: "weight", amount } });
  return `${line}${underweightFlipNote}`;
}
