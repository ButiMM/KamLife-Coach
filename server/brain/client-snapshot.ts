/**
 * CLIENT SNAPSHOT — one consistent picture of the client.
 *
 * The screenshots showed the bot saying "gained 0.8kg" and "weight hasn't moved in 3
 * weeks" in two different breaths, throwing around "18 workouts" / "11 of 16" / "Week 1"
 * / "6 weeks" with no coherent frame, because those facts are computed in several
 * different places that disagree. Every brain reply reads from THIS single function, so
 * it literally cannot contradict itself: total change and recent trend are stated
 * together, and the session/week frame is one and the same everywhere.
 *
 * Read-only. Never throws — a partial snapshot beats a failed one.
 */

import { db } from "../db";
import { weightLogs, workoutLogs, mealLogs } from "../../shared/schema";
import { eq, gte, desc, and } from "drizzle-orm";
import { weeklyTrendSlopeKg } from "../handlers/weight";
import { getPhaseNames } from "../programme";

const DAY = 86_400_000;

export async function buildClientSnapshot(user: any): Promise<string> {
  const now = Date.now();
  const since = (days: number) => new Date(now - days * DAY);
  const lines: string[] = [];

  try {
    const goal = String(user.goalType || "fat_loss").replace(/_/g, " ");
    lines.push(`Goal: ${goal}. Daily targets: ${user.calorieTarget ?? "?"} kcal, ${user.proteinTarget ?? "?"}g protein.`);

    const phase = getPhaseNames()[user.programmePhase || 1] || "Foundation";
    lines.push(`Programme: ${phase} phase, week ${user.programmeWeek || 1}, day ${user.programmeDayInWeek || 1} (week is phase-relative — it resets each phase; sessions below are the lifetime count).`);

    // ── Sessions — ONE frame: lifetime total + last 7 days + last 4 weeks ──
    const total = user.totalWorkoutsCompleted || 0;
    const wLogs = await db.select({ loggedAt: workoutLogs.loggedAt })
      .from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), eq(workoutLogs.workoutCompleted, true)))
      .orderBy(desc(workoutLogs.loggedAt)).limit(80).catch(() => [] as { loggedAt: Date | null }[]);
    const inLast = (days: number) => wLogs.filter(w => w.loggedAt && new Date(w.loggedAt).getTime() >= now - days * DAY).length;
    lines.push(`Sessions: ${total} total (lifetime), ${inLast(7)} in the last 7 days, ${inLast(28)} in the last 4 weeks. Current streak: ${user.workoutStreak || 0}.`);

    // ── Weight — ONE computation: start, now, total change AND recent trend together ──
    const wl = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt })
      .from(weightLogs).where(eq(weightLogs.userId, user.id))
      .orderBy(desc(weightLogs.loggedAt)).limit(40).catch(() => [] as { weight: string; loggedAt: Date | null }[]);
    if (wl.length === 0) {
      lines.push(`Weight: none logged yet — do not quote a weight figure.`);
    } else {
      const cur = parseFloat(String(wl[0].weight));
      const oldest = wl[wl.length - 1];
      const start = parseFloat(String(oldest.weight));
      const spanDays = Math.max(1, Math.round((now - new Date(oldest.loggedAt || now).getTime()) / DAY));
      const weeks = Math.max(1, Math.round(spanDays / 7));
      const totalChange = +(cur - start).toFixed(1);
      const recent = wl.filter(r => r.loggedAt && new Date(r.loggedAt).getTime() >= now - 21 * DAY);
      const points = recent.map(r => ({ dayOffset: Math.round(new Date(r.loggedAt!).getTime() / DAY), kg: parseFloat(String(r.weight)) }));
      const slope = weeklyTrendSlopeKg(points, 2, 5); // kg/week over the recent ~3-week window
      const recentTrend = slope === null ? "not enough recent weigh-ins to call a trend yet"
        : Math.abs(slope) < 0.1 ? "flat over the last ~3 weeks (a plateau)"
        : `${slope > 0 ? "rising" : "falling"} about ${Math.abs(slope).toFixed(2)}kg/week recently`;
      const dir = totalChange > 0 ? "+" : "";
      // Both facts in ONE line so a reply can never split them into a contradiction.
      lines.push(`Weight: started ${start}kg, now ${cur}kg — ${dir}${totalChange}kg over ${weeks} week${weeks !== 1 ? "s" : ""} total, and ${recentTrend}. When you talk about weight, state BOTH together (e.g. "up 0.8kg overall but flat the last 3 weeks — that's the plateau").`);
    }

    // ── Protein adherence, last 7 days (per-day average) ──
    const meals = await db.select({ proteinInt: mealLogs.proteinInt, loggedAt: mealLogs.loggedAt })
      .from(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, since(7))))
      .catch(() => [] as { proteinInt: number; loggedAt: Date | null }[]);
    if (meals.length > 0) {
      const byDay = new Map<string, number>();
      for (const row of meals) {
        const k = new Date(row.loggedAt || now).toISOString().slice(0, 10);
        byDay.set(k, (byDay.get(k) || 0) + (row.proteinInt || 0));
      }
      const days = [...byDay.values()];
      const avg = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
      lines.push(`Protein: averaging ${avg}g/day across ${days.length} logged day${days.length !== 1 ? "s" : ""} in the last week vs ${user.proteinTarget ?? "?"}g target.`);
    } else {
      lines.push(`Protein: nothing logged in the last 7 days — encourage logging, don't guess numbers.`);
    }
  } catch (e) {
    console.error("[CLIENT_SNAPSHOT] partial:", (e as any)?.message || e);
  }

  return lines.join("\n");
}
