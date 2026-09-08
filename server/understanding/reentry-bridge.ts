/**
 * Consumer-facing re-entry boundary.
 *
 * Keep routing consumers dependent on the canonical resolver rather than rebuilding
 * silence/return regexes locally. This adapter intentionally contains no reply text
 * and no persistence side effects.
 */
import { resolveReentry, type ReentryResolution } from "./reentry";

/**
 * THE NEWEST DURABLE THING THIS CLIENT DID (#221).
 *
 * The boundary's whole purpose is that a consumer hands over a user and cannot choose which
 * timestamp counts as engagement. Execution evidence is part of that answer, so it is read HERE,
 * once, from the rows that already store it — meal_logs, workout_logs, step_logs — rather than
 * each caller assembling its own idea of "when did they last do something".
 *
 * Lazy import so the pure resolver and its unit tests never pull in a database connection, the
 * same shape grocery-personalize uses for its profile read. Fails soft to null: a client must not
 * lose their comeback because a query timed out.
 */
export async function lastExecutionAtForUser(userId: string): Promise<Date | null> {
  try {
    const { pool } = await import("../db");
    const { rows } = await pool.query<{ at: string | null }>(
      `SELECT GREATEST(
          COALESCE((SELECT MAX(logged_at) FROM meal_logs    WHERE user_id = $1), 'epoch'),
          COALESCE((SELECT MAX(logged_at) FROM workout_logs WHERE user_id = $1), 'epoch'),
          COALESCE((SELECT MAX(logged_at) FROM step_logs    WHERE user_id = $1), 'epoch')) AS at`,
      [userId]);
    const at = rows[0]?.at ? new Date(rows[0].at) : null;
    // 'epoch' is the no-rows sentinel from the COALESCE above, not a real event.
    return at && at.getUTCFullYear() > 1971 ? at : null;
  } catch (e: any) {
    console.warn("[REENTRY] execution evidence unavailable:", e?.message);
    return null;
  }
}

export function resolveReentryForUser(input: {
  user: { lastActiveAt?: unknown };
  message: string;
  lastExecutionAt?: unknown;
  nowMs?: number;
}): ReentryResolution {
  return resolveReentry({
    lastActiveAt: input.user.lastActiveAt,
    lastExecutionAt: input.lastExecutionAt,
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
