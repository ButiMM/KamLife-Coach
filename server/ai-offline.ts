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

/**
 * CAN THE COACH THINK? (#397). On 24 Sep the OpenAI credits ran out and /health still said "ok": it
 * checked the database and the commit, not the model. Every OpenAI client in the server (11 of them)
 * goes through the global fetch, so one observer there records every model call's outcome, with no
 * change at any call site. /health reports it; the CTO watch alerts the founder from it.
 */
type AiHealth = { lastSuccessAt: string | null; lastErrorAt: string | null; lastErrorCode: string | null; errorsLastHour: number };
const aiState = { lastSuccessAt: 0, lastErrorAt: 0, lastErrorCode: null as string | null, errors: [] as number[] };
let aiObserverInstalled = false;

export function recordAiOutcome(status: number, code: string | null, now = Date.now()): void {
  if (status > 0 && status < 400) { aiState.lastSuccessAt = now; return; }
  aiState.lastErrorAt = now;
  aiState.lastErrorCode = `${status || "network"}${code ? ` ${code}` : ""}`;
  aiState.errors = [...aiState.errors.filter(t => now - t < 60 * 60 * 1000), now];
}

export function aiHealth(now = Date.now()): AiHealth {
  const iso = (t: number) => (t ? new Date(t).toISOString() : null);
  return { lastSuccessAt: iso(aiState.lastSuccessAt), lastErrorAt: iso(aiState.lastErrorAt), lastErrorCode: aiState.lastErrorCode,
    errorsLastHour: aiState.errors.filter(t => now - t < 60 * 60 * 1000).length };
}

/** Wrap the global fetch once. Only api.openai.com calls are recorded; nothing is changed about any request. */
export function installAiHealthObserver(): void {
  if (aiObserverInstalled || typeof globalThis.fetch !== "function") return;
  aiObserverInstalled = true;
  const inner = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (!url.includes("api.openai.com")) return inner(input, init);
    try {
      const res = await inner(input, init);
      let code: string | null = null;
      if (res.status >= 400) {
        try { const b: any = await res.clone().json(); code = b?.error?.code || b?.error?.type || null; } catch { /* body not JSON */ }
      }
      recordAiOutcome(res.status, code);
      return res;
    } catch (e) {
      recordAiOutcome(0, (e as any)?.code || null);
      throw e;
    }
  }) as typeof fetch;
}

// Installed at load in production, and index.ts imports this module before anything that builds an
// OpenAI client: the SDK captures fetch when a client is constructed, so a later install sees nothing.
if (process.env.NODE_ENV === "production") installAiHealthObserver();

/**
 * OUT OF CREDITS IS NOT A RATE LIMIT (#395). OpenAI answers an empty balance with a 429 too, but
 * `insufficient_quota` never clears on retry: until someone adds credits, every call fails. Tell the
 * two apart so the client is not told "30 seconds" forever and the founder is alerted.
 */
export function isQuotaExhausted(err: unknown): boolean {
  const e = err as any;
  // The SDK may expose only "429" at the top and keep the reason inside `error` (Codex @ 44b007a).
  const text = `${e?.code ?? ""} ${e?.error?.code ?? ""} ${e?.error?.type ?? ""} ${e?.message ?? ""} ${e?.error?.message ?? ""}`.toLowerCase();
  return text.includes("insufficient_quota") || text.includes("no credits remaining") || text.includes("exceeded your current quota");
}

/**
 * SLOW OR UNREACHABLE, NOT BROKEN (#441). A timeout, a dropped connection or a 5xx: the client is told
 * honestly at once (reply-verifier's COACH_NETWORK_HICCUP_REPLY) instead of waiting on the model twice.
 * A dead key or an empty balance is not this: those fall through to askCoachK, which alerts the founder.
 */
export function isModelSlowOrUnreachable(err: unknown): boolean {
  const e = err as any;
  const text = `${e?.constructor?.name || e?.name || ""} ${e?.code || ""} ${e?.message || ""}`;
  return Number(e?.status ?? e?.statusCode ?? 0) >= 500 || /APIConnection|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(text);
}

/** A dead key or an empty balance does not fix itself: alert the founder at most once an hour, not on every turn. */
let lastAiDownAlert = 0;
export function shouldAlertAiDown(now = Date.now()): boolean {
  if (now - lastAiDownAlert < 60 * 60 * 1000) return false;
  lastAiDownAlert = now;
  return true;
}
/** The alert did not reach the founder: give the slot back so the next failure tries again. */
export function releaseAiDownAlert(): void { lastAiDownAlert = 0; }
