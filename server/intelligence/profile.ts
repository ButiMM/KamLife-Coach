/**
 * Client Intelligence Profile (CIP) builder.
 *
 * Queries the full lifetime history for a client and produces a structured
 * profile + a natural-language narrative injected into every GPT call.
 *
 * Updated weekly (Sunday night) by runCipUpdate(). Read at message time via
 * a fast single SELECT — never blocks the message pipeline.
 *
 * Design constraints:
 * - Zero GPT calls — all narrative generation is template-based.
 * - Fails silently: if any query errors, returns a partial profile.
 * - New clients (< 7 days) get a minimal profile — nothing to narrate yet.
 */

import { db } from "../db";
import {
  weightLogs, workoutLogs, mealLogs, stepLogs, chatHistory,
  clientIntelligenceProfiles,
} from "../../shared/schema";
import { eq, gte, and, sql, asc } from "drizzle-orm";

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface MonthlySnapshot {
  month: string;      // "2025-03"
  sessions: number;
  planned: number;
  proteinDays: number;
  avgWeightKg: number | null;
}

// ── Streak helper — given sorted date strings, find the longest run of
// consecutive calendar days ──────────────────────────────────────────────────
function longestConsecutiveRun(sortedDates: string[]): number {
  if (sortedDates.length === 0) return 0;
  const unique = [...new Set(sortedDates)].sort();
  let best = 1, cur = 1;
  for (let i = 1; i < unique.length; i++) {
    const prev = new Date(unique[i - 1]);
    const curr = new Date(unique[i]);
    const diff = (curr.getTime() - prev.getTime()) / 86_400_000;
    if (diff === 1) { cur++; best = Math.max(best, cur); }
    else cur = 1;
  }
  return best;
}

// ── SAST date string from a UTC timestamp ────────────────────────────────────
function toSASTDate(ts: Date | null | undefined): string {
  if (!ts) return "";
  const d = new Date(new Date(ts).getTime() + 2 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ── Main builder ─────────────────────────────────────────────────────────────
export async function buildClientProfile(user: {
  id: string;
  name?: string | null;
  trainingDaysPerWeek?: number | null;
  proteinTarget?: number | null;
  createdAt?: Date | string | null;
}): Promise<void> {
  const userId = user.id;
  const name = (user.name || "").split(" ")[0] || "Client";
  const proteinTarget = user.proteinTarget || 120;
  const trainingDaysPerWeek = user.trainingDaysPerWeek || 3;
  const startedAt = user.createdAt ? new Date(user.createdAt) : new Date();
  const weeksOnProgramme = Math.max(1, Math.floor((Date.now() - startedAt.getTime()) / (7 * 86_400_000)));

  // Don't build a CIP for brand-new clients — there's nothing to narrate yet
  if (weeksOnProgramme < 1) return;

  try {
    const [
      allWeights,
      allWorkouts,
      allMealDays,
      allStepDays,
      allChats,
    ] = await Promise.all([
      db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt })
        .from(weightLogs).where(eq(weightLogs.userId, userId)).orderBy(asc(weightLogs.loggedAt)),
      db.select({ loggedAt: workoutLogs.loggedAt })
        .from(workoutLogs).where(eq(workoutLogs.userId, userId)).orderBy(asc(workoutLogs.loggedAt)),
      db.select({
        day: sql<string>`DATE(${mealLogs.loggedAt} AT TIME ZONE 'Africa/Johannesburg')`,
        protein: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
      }).from(mealLogs).where(eq(mealLogs.userId, userId))
        .groupBy(sql`DATE(${mealLogs.loggedAt} AT TIME ZONE 'Africa/Johannesburg')`),
      db.select({ day: sql<string>`DATE(${stepLogs.loggedAt} AT TIME ZONE 'Africa/Johannesburg')` })
        .from(stepLogs).where(eq(stepLogs.userId, userId))
        .groupBy(sql`DATE(${stepLogs.loggedAt} AT TIME ZONE 'Africa/Johannesburg')`),
      db.select({ createdAt: chatHistory.createdAt, intent: chatHistory.intent })
        .from(chatHistory).where(eq(chatHistory.userId, userId)),
    ]);

    // ── Weight journey ────────────────────────────────────────────────────────
    const startWeightKg = allWeights.length > 0
      ? parseFloat(String(allWeights[0].weight)) : null;
    const currentWeightKg = allWeights.length > 0
      ? parseFloat(String(allWeights[allWeights.length - 1].weight)) : null;
    const bestWeightKg = allWeights.length > 0
      ? Math.min(...allWeights.map(w => parseFloat(String(w.weight)))) : null;
    const totalKgChanged = (startWeightKg !== null && currentWeightKg !== null)
      ? parseFloat((currentWeightKg - startWeightKg).toFixed(1)) : null;

    // Plateau detection — count 3-week windows where weight moved < 0.5kg
    let plateauCount = 0;
    for (let i = 0; i + 20 < allWeights.length; i += 7) {
      const slice = allWeights.slice(i, i + 21);
      const lo = Math.min(...slice.map(w => parseFloat(String(w.weight))));
      const hi = Math.max(...slice.map(w => parseFloat(String(w.weight))));
      if (hi - lo < 0.5) plateauCount++;
    }

    // ── Training records ─────────────────────────────────────────────────────
    const workoutDates = allWorkouts.map(w => toSASTDate(w.loggedAt)).filter(Boolean);
    const longestWorkoutStreak = longestConsecutiveRun(workoutDates);

    // Best week sessions — group by ISO week
    const workoutsByWeek: Record<string, number> = {};
    for (const w of allWorkouts) {
      if (!w.loggedAt) continue;
      const d = new Date(new Date(w.loggedAt).getTime() + 2 * 3_600_000);
      const dayOfYear = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000);
      const wk = `${d.getUTCFullYear()}-W${String(Math.floor(dayOfYear / 7)).padStart(2, "0")}`;
      workoutsByWeek[wk] = (workoutsByWeek[wk] || 0) + 1;
    }
    const bestWeekSessions = Object.values(workoutsByWeek).length > 0
      ? Math.max(...Object.values(workoutsByWeek)) : 0;

    // Lifetime session compliance
    const totalPlanned = trainingDaysPerWeek * weeksOnProgramme;
    const lifetimeSessionCompliance = totalPlanned > 0
      ? parseFloat((allWorkouts.length / totalPlanned).toFixed(3)) : null;

    // ── Food records ─────────────────────────────────────────────────────────
    const foodDates = allMealDays.map(d => d.day).filter(Boolean);
    const longestFoodStreak = longestConsecutiveRun(foodDates);
    const lifetimeFoodLogDays = foodDates.length;

    // Best week avg protein — group meal days by ISO week
    const protByWeek: Record<string, number[]> = {};
    for (const d of allMealDays) {
      if (!d.day || d.protein === 0) continue;
      const dt = new Date(d.day + "T00:00:00Z");
      const dayOfYear = Math.floor((dt.getTime() - Date.UTC(dt.getUTCFullYear(), 0, 1)) / 86_400_000);
      const wk = `${dt.getUTCFullYear()}-W${String(Math.floor(dayOfYear / 7)).padStart(2, "0")}`;
      protByWeek[wk] = protByWeek[wk] || [];
      protByWeek[wk].push(d.protein);
    }
    const weeklyAvgProteins = Object.values(protByWeek)
      .filter(days => days.length >= 3)
      .map(days => Math.round(days.reduce((a, b) => a + b, 0) / days.length));
    const bestWeekAvgProteinG = weeklyAvgProteins.length > 0
      ? Math.max(...weeklyAvgProteins) : 0;

    // ── Monthly snapshots ─────────────────────────────────────────────────────
    const monthlySnapshots: MonthlySnapshot[] = [];
    const monthSet = new Set<string>();
    const since = new Date(startedAt);
    const now = new Date();
    while (since <= now) {
      const month = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}`;
      monthSet.add(month);
      since.setMonth(since.getMonth() + 1);
    }
    for (const month of [...monthSet].slice(-6)) { // last 6 months
      const [yr, mo] = month.split("-").map(Number);
      const mStart = new Date(Date.UTC(yr, mo - 1, 1));
      const mEnd = new Date(Date.UTC(yr, mo, 1));
      const monthWorkouts = allWorkouts.filter(w => {
        const t = new Date(w.loggedAt || 0).getTime();
        return t >= mStart.getTime() && t < mEnd.getTime();
      }).length;
      const monthProtDays = allMealDays.filter(d => {
        if (!d.day) return false;
        return d.day.startsWith(month) && d.protein >= proteinTarget * 0.8;
      }).length;
      const monthWeights = allWeights.filter(w => {
        const t = new Date(w.loggedAt || 0).getTime();
        return t >= mStart.getTime() && t < mEnd.getTime();
      });
      const avgWeightKg = monthWeights.length > 0
        ? parseFloat((monthWeights.reduce((s, w) => s + parseFloat(String(w.weight)), 0) / monthWeights.length).toFixed(1))
        : null;
      const weeksInMonth = 4;
      monthlySnapshots.push({
        month,
        sessions: monthWorkouts,
        planned: trainingDaysPerWeek * weeksInMonth,
        proteinDays: monthProtDays,
        avgWeightKg,
      });
    }

    // ── Behavioral fingerprint ────────────────────────────────────────────────
    const dowCounts: number[] = new Array(7).fill(0);
    const hourCounts: number[] = new Array(24).fill(0);
    for (const c of allChats) {
      if (!c.createdAt) continue;
      const sast = new Date(new Date(c.createdAt).getTime() + 2 * 3_600_000);
      dowCounts[sast.getUTCDay()]++;
      hourCounts[sast.getUTCHours()]++;
    }
    const weakestDow = allChats.length > 14
      ? dowCounts.indexOf(Math.min(...dowCounts)) : null;
    const peakEngagementHour = allChats.length > 14
      ? hourCounts.indexOf(Math.max(...hourCounts)) : null;

    // ── Pattern flags ─────────────────────────────────────────────────────────
    const patternFlags: string[] = [];
    if (weakestDow !== null) patternFlags.push(`silent_${DOW_NAMES[weakestDow].toLowerCase()}s`);
    const totalFoodDays = allMealDays.length;
    const totalDays = Math.max(1, Math.floor((Date.now() - startedAt.getTime()) / 86_400_000));
    if (totalFoodDays / totalDays >= 0.7) patternFlags.push("consistent_logger");
    else if (totalFoodDays / totalDays < 0.3) patternFlags.push("sporadic_logger");
    if (lifetimeSessionCompliance !== null && lifetimeSessionCompliance >= 0.8) patternFlags.push("high_compliance");
    if (lifetimeSessionCompliance !== null && lifetimeSessionCompliance < 0.4) patternFlags.push("low_compliance");
    const protCompliantDays = allMealDays.filter(d => d.protein >= proteinTarget * 0.8).length;
    const protLoggedDays = allMealDays.filter(d => d.protein > 0).length;
    if (protLoggedDays >= 14 && protCompliantDays / protLoggedDays < 0.4) patternFlags.push("chronic_protein_gap");
    if (plateauCount >= 2) patternFlags.push("plateau_prone");

    // ── Narrative ─────────────────────────────────────────────────────────────
    const coachNarrative = buildNarrative({
      name, weeksOnProgramme,
      startWeightKg, currentWeightKg, bestWeightKg, totalKgChanged,
      longestWorkoutStreak, bestWeekSessions, bestWeekAvgProteinG, proteinTarget,
      lifetimeFoodLogDays, totalDays, plateauCount,
      weakestDow, peakEngagementHour,
      patternFlags, monthlySnapshots,
      lifetimeSessionCompliance,
    });

    // ── Upsert ────────────────────────────────────────────────────────────────
    await db.insert(clientIntelligenceProfiles).values({
      userId,
      updatedAt: new Date(),
      startWeightKg: startWeightKg !== null ? String(startWeightKg) : null,
      bestWeightKg: bestWeightKg !== null ? String(bestWeightKg) : null,
      totalKgChanged: totalKgChanged !== null ? String(totalKgChanged) : null,
      longestWorkoutStreak,
      longestFoodStreak,
      bestWeekAvgProteinG,
      bestWeekSessions,
      weakestDow,
      peakEngagementHour,
      lifetimeSessionCompliance: lifetimeSessionCompliance !== null ? String(lifetimeSessionCompliance) : null,
      lifetimeFoodLogDays,
      plateauCount,
      monthlySnapshots,
      patternFlags,
      coachNarrative,
    }).onConflictDoUpdate({
      target: clientIntelligenceProfiles.userId,
      set: {
        updatedAt: new Date(),
        startWeightKg: startWeightKg !== null ? String(startWeightKg) : null,
        bestWeightKg: bestWeightKg !== null ? String(bestWeightKg) : null,
        totalKgChanged: totalKgChanged !== null ? String(totalKgChanged) : null,
        longestWorkoutStreak,
        longestFoodStreak,
        bestWeekAvgProteinG,
        bestWeekSessions,
        weakestDow,
        peakEngagementHour,
        lifetimeSessionCompliance: lifetimeSessionCompliance !== null ? String(lifetimeSessionCompliance) : null,
        lifetimeFoodLogDays,
        plateauCount,
        monthlySnapshots,
        patternFlags,
        coachNarrative,
      },
    });
  } catch (err) {
    console.error(`[CIP] buildClientProfile error for ${userId}:`, err);
  }
}

// ── Narrative generator ──────────────────────────────────────────────────────
function buildNarrative(d: {
  name: string;
  weeksOnProgramme: number;
  startWeightKg: number | null;
  currentWeightKg: number | null;
  bestWeightKg: number | null;
  totalKgChanged: number | null;
  longestWorkoutStreak: number;
  bestWeekSessions: number;
  bestWeekAvgProteinG: number;
  proteinTarget: number;
  lifetimeFoodLogDays: number;
  totalDays: number;
  plateauCount: number;
  weakestDow: number | null;
  peakEngagementHour: number | null;
  patternFlags: string[];
  monthlySnapshots: MonthlySnapshot[];
  lifetimeSessionCompliance: number | null;
}): string {
  const lines: string[] = [];

  // Opening — how long and weight journey
  const timeLabel = d.weeksOnProgramme >= 8
    ? `${Math.floor(d.weeksOnProgramme / 4)} months`
    : `${d.weeksOnProgramme} weeks`;

  if (d.startWeightKg !== null && d.totalKgChanged !== null) {
    const direction = d.totalKgChanged < -0.5
      ? `lost ${Math.abs(d.totalKgChanged)}kg`
      : d.totalKgChanged > 0.5
        ? `gained ${d.totalKgChanged}kg`
        : `weight holding steady`;
    lines.push(`${d.name} has been on KamLife for ${timeLabel}, starting at ${d.startWeightKg}kg — ${direction} so far.`);
    if (d.bestWeightKg !== null && d.bestWeightKg < d.startWeightKg - 1) {
      lines.push(`Best weight reached: ${d.bestWeightKg}kg.`);
    }
  } else {
    lines.push(`${d.name} has been on KamLife for ${timeLabel}.`);
  }

  // Training records
  if (d.longestWorkoutStreak >= 3) {
    lines.push(`Longest training streak: ${d.longestWorkoutStreak} sessions. Best week: ${d.bestWeekSessions} sessions.`);
  }
  if (d.lifetimeSessionCompliance !== null) {
    const pct = Math.round(d.lifetimeSessionCompliance * 100);
    lines.push(`Lifetime session compliance: ${pct}%.`);
  }

  // Protein
  if (d.bestWeekAvgProteinG >= d.proteinTarget * 0.8) {
    lines.push(`Best protein week ever: ${d.bestWeekAvgProteinG}g avg — has hit target before, can do it again.`);
  } else if (d.bestWeekAvgProteinG > 0) {
    lines.push(`Best protein week: ${d.bestWeekAvgProteinG}g avg (target ${d.proteinTarget}g — hasn't fully closed the gap yet).`);
  }

  // Food logging habit
  const logRate = d.totalDays > 0 ? d.lifetimeFoodLogDays / d.totalDays : 0;
  if (logRate >= 0.7) lines.push(`Consistent food logger — ${d.lifetimeFoodLogDays} days logged.`);
  else if (logRate < 0.3 && d.lifetimeFoodLogDays > 0) lines.push(`Sporadic food logger — only ${d.lifetimeFoodLogDays} days logged in ${d.totalDays} days.`);

  // Plateaus
  if (d.plateauCount >= 2) lines.push(`Has hit ${d.plateauCount} weight plateaus — pattern of progress then stall.`);

  // Behavioral pattern
  if (d.weakestDow !== null) lines.push(`Most likely to go quiet on ${DOW_NAMES[d.weakestDow]}s.`);
  if (d.peakEngagementHour !== null) {
    const h = d.peakEngagementHour;
    const label = h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;
    lines.push(`Most responsive around ${label} SAST.`);
  }

  // Monthly trend — last 2 months
  const recent = d.monthlySnapshots.slice(-2);
  if (recent.length === 2) {
    const prev = recent[0];
    const curr = recent[1];
    const currPct = curr.planned > 0 ? Math.round((curr.sessions / curr.planned) * 100) : 0;
    const prevPct = prev.planned > 0 ? Math.round((prev.sessions / prev.planned) * 100) : 0;
    if (currPct >= prevPct + 15) lines.push(`Session compliance improving — ${prevPct}% last month → ${currPct}% this month.`);
    else if (currPct <= prevPct - 15) lines.push(`Session compliance dropping — was ${prevPct}% last month, now ${currPct}%.`);
  }

  return lines.join(" ").slice(0, 800);
}

// ── Read helper — used in GPT injection ──────────────────────────────────────
export async function getClientNarrative(userId: string): Promise<string | null> {
  try {
    const rows = await db.select({ coachNarrative: clientIntelligenceProfiles.coachNarrative })
      .from(clientIntelligenceProfiles)
      .where(eq(clientIntelligenceProfiles.userId, userId))
      .limit(1);
    return rows[0]?.coachNarrative || null;
  } catch {
    return null;
  }
}
