/**
 * Consumer-facing re-entry boundary.
 *
 * Keep routing consumers dependent on the canonical resolver rather than rebuilding
 * silence/return regexes locally. This adapter intentionally contains no reply text
 * and no persistence side effects.
 */
import { resolveReentry, type ReentryResolution } from "./reentry";

/** What this client durably did, at the resolution the resolver needs to speak about it. */
export interface ExecutionEvidence {
  /** The newest durable event of ANY kind — meal, workout or steps. */
  lastExecutionAt: Date | null;
  /**
   * The newest WORKOUT specifically. Carried separately because a claim about training must rest
   * on training: a client who logged meals while quiet has engaged without having trained, and one
   * flag cannot answer both questions without saying something false to one of them.
   */
  lastWorkoutAt: Date | null;
}

/**
 * THE NEWEST DURABLE THINGS THIS CLIENT DID (#221).
 *
 * The boundary's whole purpose is that a consumer hands over a user and cannot choose which
 * timestamp counts as engagement. Execution evidence is part of that answer, so it is read HERE,
 * once, from the rows that already store it — meal_logs, workout_logs, step_logs — rather than
 * each caller assembling its own idea of "when did they last do something".
 *
 * The three maxima come back separately and are compared in TypeScript. The earlier version did
 * `GREATEST(COALESCE(…, 'epoch'), …)`, which then had to tell a real event apart from the sentinel
 * by its year — a second thing to get right for no gain — and could only ever return ONE
 * timestamp, which is precisely why the training sentence had to speak from evidence that was not
 * about training.
 *
 * Lazy import so the pure resolver and its unit tests never pull in a database connection, the
 * same shape grocery-personalize uses for its profile read. Fails soft to nulls: a client must not
 * lose their comeback because a query timed out.
 */
export async function executionEvidenceForUser(userId: string): Promise<ExecutionEvidence> {
  try {
    const { pool } = await import("../db");
    const { rows } = await pool.query<{ meal_at: string | null; workout_at: string | null; step_at: string | null }>(
      `SELECT (SELECT MAX(logged_at) FROM meal_logs    WHERE user_id = $1) AS meal_at,
              (SELECT MAX(logged_at) FROM workout_logs WHERE user_id = $1) AS workout_at,
              (SELECT MAX(logged_at) FROM step_logs    WHERE user_id = $1) AS step_at`,
      [userId]);
    const at = (v: string | null | undefined) => (v ? new Date(v) : null);
    const workout = at(rows[0]?.workout_at);
    const newest = [at(rows[0]?.meal_at), workout, at(rows[0]?.step_at)]
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] || null;
    return { lastExecutionAt: newest, lastWorkoutAt: workout };
  } catch (e: any) {
    console.warn("[REENTRY] execution evidence unavailable:", e?.message);
    return { lastExecutionAt: null, lastWorkoutAt: null };
  }
}

export function resolveReentryForUser(input: {
  user: { lastActiveAt?: unknown };
  message: string;
  lastExecutionAt?: unknown;
  lastWorkoutAt?: unknown;
  nowMs?: number;
}): ReentryResolution {
  return resolveReentry({
    lastActiveAt: input.user.lastActiveAt,
    lastExecutionAt: input.lastExecutionAt,
    lastWorkoutAt: input.lastWorkoutAt,
    message: input.message,
    nowMs: input.nowMs,
  });
}

export function shouldHandleComebackForUser(input: {
  user: { lastActiveAt?: unknown };
  message: string;
  nowMs?: number;
}): boolean {
  return resolveReentryForUser(input).shouldHandleComeback;
}
