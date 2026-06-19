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
      return `⚠️ *${nm}you're losing very fast — ${pace.toFixed(2)}kg a week.* Dropping this quickly can burn muscle and slow your metabolism, and it usually means you're not eating enough. Can you tell me what a normal day's food looks like for you? Let's make sure you're eating enough to do this safely.`;
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
  let recentRateKgPerWeek: number | null = null;
  if (recentWindow.length >= 3) {
    const oldest = recentWindow[0];
    const newest = recentWindow[recentWindow.length - 1];
    const daySpan = (new Date(newest.loggedAt!).getTime() - new Date(oldest.loggedAt!).getTime()) / 86_400_000;
    if (daySpan >= 5) {
      recentRateKgPerWeek = (parseFloat(String(newest.weight)) - parseFloat(String(oldest.weight))) / (daySpan / 7);
    }
  }

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

    if (goal === "fat_loss") {
      // Ideal: -0.25 to -0.75kg/week
      if (rate < -0.85) {
        calAdjust = 150;
        trendLabel = `📉 *${rateStr} over 2 weeks*`;
        trendStatus = `⚠️ too fast — losing muscle alongside fat. Adding 150 kcal to protect your muscle.`;
      } else if (rate < -0.75) {
        calAdjust = 100;
        trendLabel = `📉 *${rateStr} over 2 weeks*`;
        trendStatus = `at the aggressive end. Adding 100 kcal — sustainable pace matters more than speed.`;
      } else if (rate <= -0.2) {
        calAdjust = 0;
        trendLabel = `📉 *${rateStr} over 2 weeks*`;
        trendStatus = `✅ right on target. Keep going.`;
      } else if (rate < 0) {
        calAdjust = -100;
        trendLabel = `📉 *${rateStr} over 2 weeks*`;
        trendStatus = `slower than ideal. Removing 100 kcal to get progress moving.`;
      } else {
        calAdjust = -150;
        trendLabel = `📈 *${rateStr} over 2 weeks*`;
        trendStatus = `weight is going up on a fat loss programme. Removing 150 kcal and review your food log.`;
      }
    } else if (goal === "muscle_gain") {
      // Ideal: +0.1 to +0.35kg/week
      if (rate > 0.45) {
        calAdjust = -100;
        trendLabel = `📈 *${rateStr} over 2 weeks*`;
        trendStatus = `gaining fast — some of that will be fat. Pulling back 100 kcal to keep it lean.`;
      } else if (rate >= 0.08) {
        calAdjust = 0;
        trendLabel = `📈 *${rateStr} over 2 weeks*`;
        trendStatus = `✅ ideal lean gain pace. Stay exactly here.`;
      } else if (rate > -0.1) {
        calAdjust = 100;
        trendLabel = `➡️ *${rateStr} over 2 weeks*`;
        trendStatus = `scale isn't moving — muscle growth needs a surplus. Adding 100 kcal.`;
      } else {
        calAdjust = 150;
        trendLabel = `📉 *${rateStr} over 2 weeks*`;
        trendStatus = `losing weight on a muscle gain programme. Adding 150 kcal — you need a surplus to build.`;
      }
    } else if (goal === "recomposition") {
      trendLabel = `➡️ *${rateStr} over 2 weeks*`;
      if (Math.abs(rate) <= 0.3) {
        trendStatus = `✅ scale is stable while body composition is shifting. Exactly right.`;
      } else if (rate < -0.3) {
        trendStatus = `dropping a bit fast for recomp. Make sure you're hitting your calorie target each day.`;
      } else {
        trendStatus = `slight upward drift. Tighten carbs on rest days.`;
      }
    }

    if (calAdjust !== 0) {
      finalCals = Math.max(1200, Math.min(4000, newCals + calAdjust));
      await db.update(users).set({ calorieTarget: finalCals }).where(eq(users.phoneNumber, phone));
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
      plateauNote = `\n\n_3-week average hasn't moved. Your body has adapted. Options: tighten portions slightly, add a 20-minute daily walk, or take a 1–2 week diet break at maintenance calories. Pick one and commit for a week._`;
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
    ? `\n\n*Targets updated: ${finalCals} kcal/day | ${finalProtein}g protein.*${adjustNote}`
    : `\n\nTargets: ${finalCals} kcal/day | ${finalProtein}g protein.`;

  // ── Trend line (only when we have recent data) ──
  const trendLine = trendLabel ? `\n\n${trendLabel} — ${trendStatus}` : (milestoneCelebration ? "" : journeyNote);

  return `Weight logged: *${newKg}kg.*${changeNote}${milestoneCelebration}${trendLine}${targetsLine}${predictionNote}${streakNote}${plateauNote}`;
}
