/**
 * AI_OFFLINE — hard kill switch for ALL OpenAI network calls.
 *
 * Set OFFLINE_AI=1 (or KAMLIFE_DB_STUB=1, which the routing audit already sets)
 * to make every OpenAI entry point throw INSTANTLY instead of touching the network.
 * Every call site already has a try/catch that falls back to a deterministic
 * response, so the real handler pipeline runs with zero latency and zero flakiness.
 *
 * Why this exists: the routing audit and unit suites must exercise the REAL
 * handler pipeline (real regexes, real handler order) WITHOUT ever calling OpenAI.
 * A fake API key does NOT make calls fail fast — it still incurs DNS + TCP + TLS
 * + the 3-attempt exponential backoff (1s, 2s, 4s) before throwing, which is
 * seconds of dead time per call and made `npm test` appear to hang. Throwing
 * before the network attempt removes that entirely and keeps tests deterministic.
 */
export const AI_OFFLINE =
  process.env.OFFLINE_AI === "1" || process.env.KAMLIFE_DB_STUB === "1";

/** Marker used by isAiOfflineError() to detect expected offline throws vs real errors. */
const AI_OFFLINE_MARKER = "__ai_offline__";

/** Throws a fast, silent offline marker when AI is disabled. */
export function assertAiOnline(label: string): void {
  if (AI_OFFLINE) {
    const err = new Error(`[ai-offline] ${label}`);
    (err as any)[AI_OFFLINE_MARKER] = true;
    throw err;
  }
}

/**
 * Returns true when the error came from assertAiOnline — i.e. it is expected
 * test-mode behavior, not a real failure. Use in catch blocks to skip error logging.
 */
export function isAiOfflineError(err: unknown): boolean {
  return !!(err && (err as any)[AI_OFFLINE_MARKER]);
}
