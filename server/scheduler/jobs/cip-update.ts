/**
 * Weekly behaviour patterns — Sunday 10pm SAST (20:00 UTC).
 *
 * D2b (CTO 6 Oct): for every active client, the patterns their attributable training outcomes show
 * are written to the client record as `pattern` facts (core/client-record.ts writePatternFacts), and
 * the decision reads them from there. Deterministic: no model call. The old client intelligence
 * profile (streaks, a template narrative, an audit of both) went with intelligence/profile.ts; the
 * narrative was a second, unvalidated voice describing the client, and the record replaces it.
 */

import { db, getActiveClients, workoutLogs, eq } from "../shared";
import { dailyConstraints } from "../../../shared/schema";
import { and, asc, gte } from "drizzle-orm";
import { sastDayKey, sastDaysBetween, sastWeekStart } from "../../sast";
import { writePatternFacts, type BehaviourPattern, type BehaviourPatternEvidence, type BehaviourPatternKind } from "../../core/client-record";

type TrainingOutcomeRow = { id: number; day: string; state: string; via: string; saidAt: Date };

const dayAtNoon = (day: string) => new Date(`${day}T12:00:00+02:00`);
const weekOf = (day: string) => sastDayKey(sastWeekStart(dayAtNoon(day)));
const isWeekendDay = (day: string) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());

/**
 * Turn attributable training outcomes into bounded patterns.
 *
 * A missing workout row is never evidence. Failure rows exist only because a client explicitly
 * closed an open canonical training loop; completion rows exist only when that exact loop closed
 * through the workout ledger. Negative patterns require two distinct weeks. Recent completed
 * sessions can supersede them, and old evidence remains inspectable without retaining authority.
 */
export function buildBehaviourPatterns(rows: TrainingOutcomeRow[], workoutDays: string[], now = new Date()): BehaviourPattern[] {
  const evidence = rows
    // Plain `said` also represents ordinary day constraints, including safety/injury contexts.
    // Only rows written while an exact canonical loop closed are attributable outcomes.
    .filter(row => ["said_open", "said_time", "workout_logged", "workout_logged_minimum"].includes(row.via))
    .map((row): BehaviourPatternEvidence => ({
      id: row.id, day: row.day, source: "daily_constraints",
      outcome: row.state === "released" ? "completed" : "failed",
      ...(row.via === "said_time" ? { reason: "time" as const } : {}),
      ...(row.via === "workout_logged_minimum" ? { intervention: "minimum" as const } : {}),
    }));
  const completedDays = [...new Set(workoutDays)].sort();
  const patterns: BehaviourPattern[] = [];

  const negative = (kind: Extract<BehaviourPatternKind, "weekend_training_misses" | "work_pressure_training_misses">,
    supports: BehaviourPatternEvidence[], contradictions: string[]) => {
    const distinct = [...new Map(supports.map(e => [weekOf(e.day), e])).values()].sort((a, b) => a.day.localeCompare(b.day));
    if (distinct.length < 2) return;
    const last = distinct[distinct.length - 1].day;
    const laterContradictions = [...new Set(contradictions.filter(day => day > last).map(weekOf))];
    const age = sastDaysBetween(dayAtNoon(last), now);
    patterns.push({
      kind, status: laterContradictions.length >= 2 ? "superseded" : age > 42 ? "decayed" : "active",
      supportCount: distinct.length, contradictionCount: laterContradictions.length,
      confidence: distinct.length >= 3 ? "strong" : "supported",
      firstObservedDay: distinct[0].day, lastObservedDay: last, evidence: distinct.slice(-6),
    });
  };

  const failed = evidence.filter(e => e.outcome === "failed");
  negative("weekend_training_misses", failed.filter(e => isWeekendDay(e.day)), completedDays.filter(isWeekendDay));
  negative("work_pressure_training_misses", failed.filter(e => e.reason === "time"), completedDays);

  const minimum = evidence.filter(e => e.outcome === "completed" && e.intervention === "minimum").sort((a, b) => a.day.localeCompare(b.day));
  if (minimum.length > 0) {
    const last = minimum[minimum.length - 1].day;
    patterns.push({
      kind: "minimum_training_reengaged",
      status: sastDaysBetween(dayAtNoon(last), now) > 42 ? "decayed" : "active",
      supportCount: minimum.length, contradictionCount: 0,
      // One linked intervention -> workout outcome is a directly observed result, not an inferred
      // recurrence. It may be remembered as observed, while one isolated miss is never a pattern.
      confidence: minimum.length >= 3 ? "strong" : minimum.length >= 2 ? "supported" : "observed",
      firstObservedDay: minimum[0].day, lastObservedDay: last, evidence: minimum.slice(-6),
    });
  }
  return patterns;
}

/** Read one client's evidence and write their patterns to the record. Returns rows written. */
export async function updateClientPatterns(userId: string, now = new Date()): Promise<number> {
  const [outcomes, workouts] = await Promise.all([
    db.select({ id: dailyConstraints.id, day: dailyConstraints.day, state: dailyConstraints.state, via: dailyConstraints.via, saidAt: dailyConstraints.saidAt })
      .from(dailyConstraints).where(and(eq(dailyConstraints.userId, userId), eq(dailyConstraints.kind, "training"),
        gte(dailyConstraints.saidAt, new Date(now.getTime() - 120 * 86_400_000)))).orderBy(asc(dailyConstraints.saidAt)),
    db.select({ loggedAt: workoutLogs.loggedAt }).from(workoutLogs)
      .where(and(eq(workoutLogs.userId, userId), eq(workoutLogs.workoutCompleted, true))),
  ]);
  const days = workouts.map(w => (w.loggedAt ? sastDayKey(new Date(w.loggedAt)) : "")).filter(Boolean);
  return writePatternFacts(userId, buildBehaviourPatterns(outcomes as TrainingOutcomeRow[], days, now));
}

export async function runCipUpdate(): Promise<void> {
  console.log("[SCHEDULER] JOB: behaviour patterns");
  let written = 0, errored = 0;
  for (const client of await getActiveClients()) {
    try { written += await updateClientPatterns(client.id); }
    catch (err) { errored++; console.error(`[PATTERNS] Failed for ${client.id?.slice(-6)}:`, err); }
  }
  console.log(`[PATTERNS] ${written} pattern rows written, ${errored} errors`);
}
