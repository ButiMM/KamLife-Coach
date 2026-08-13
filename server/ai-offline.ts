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
/**
 * PRECEDENCE (2026-08-12). The stub IMPLIES offline, because the offline suites all set it and
 * none of them want the network. But the two are different concerns — "do not use the real
 * database" is not "do not call the model" — and the OR made the implication unbreakable.
 *
 * That cost a whole run. script/hunger-gauntlet.ts sets KAMLIFE_DB_STUB=1 so it needs no
 * database (its evidence is constructed in memory), which silently disabled the model on the one
 * script whose entire purpose is calling it: assertAiOnline threw, the engine caught it and
 * failed open to null, and every case scored an empty reply against prohibition-shaped checks
 * that an empty string cannot violate. Fourteen vacuous passes.
 *
 * So an EXPLICIT OFFLINE_AI=0 now beats the stub's implication. Production never sets it, so
 * production semantics are untouched — this only lets a caller that genuinely wants the model,
 * and genuinely does not want the database, say so.
 */
export const AI_OFFLINE = process.env.OFFLINE_AI === "0"
  ? false
  : (process.env.OFFLINE_AI === "1" || process.env.KAMLIFE_DB_STUB === "1");

// One clear signal at startup instead of total silence — so a reader of CI output knows
// WHY there are no GPT responses, without us printing a stack trace per skipped call.
if (AI_OFFLINE) {
  console.log("[AI_OFFLINE] OpenAI calls disabled for test mode — handlers fall back deterministically");
}

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
