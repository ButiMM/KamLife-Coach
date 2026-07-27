/**
 * USAGE GOVERNOR — automatic per-member daily caps on the expensive things, so spend can never
 * run away without anyone watching (2026-07-22, founder: "we need automatic safeguards — caps
 * that protect margin but still deliver value. I won't always be there to see it.").
 *
 * A flat R199 against unbounded voice + vision is the margin leak. This puts a hard DAILY ceiling
 * on the two costly operations — VOICE notes (ElevenLabs) and IMAGE analysis (vision) — per member.
 * Normal use never touches the cap (real people don't log 15 meal photos or trigger 3 voice notes
 * a day); a bug-loop or a spammer hits it and degrades GRACEFULLY: voice falls back to text, vision
 * asks them to type the meal. Nothing breaks, the value is still there, and margin is protected
 * without a human in the loop.
 *
 * Counts come from gpt_costs (already per-member, per-day, indexed) — voice rows are feature='voice',
 * vision rows feature='vision'. Fail-OPEN: if the count read errors, the op is allowed — a margin
 * guard must never silently break the product. Killswitch: USAGE_CAPS=off.
 */

import { db } from "./db";
import { gptCosts } from "../shared/schema";
import { eq, and, gte, inArray, sql } from "drizzle-orm";
import { sastDayStart } from "./utils";
import { ceilingState, monthlyCeilingZar, usdToZarRate } from "./spend-ceiling";

export type CappedOp = "voice" | "vision";

// The gpt_costs.feature values that count toward each cap.
const FEATURES: Record<CappedOp, string[]> = {
  voice: ["voice"],
  vision: ["vision", "food_vision"],
};

// Defaults chosen so a normal member NEVER hits them, but a runaway loop / spammer does:
//   • voice: milestone/recap voices are rare (<1/day normally) — 3 catches a loop.
//   • vision: nobody photographs >15 real meals a day — 15 caps abuse, keeps all real logging.
// Both are env-tunable for tightening in production without a deploy.
function capFor(op: CappedOp): number {
  const env = op === "voice" ? process.env.VOICE_CAP_PER_DAY : process.env.VISION_CAP_PER_DAY;
  const n = env ? parseInt(env, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : (op === "voice" ? 3 : 15);
}

/** PURE — the decision, given today's count and the cap. Exposed for tests. */
export function isWithinCap(countToday: number, cap: number): boolean {
  return countToday < cap;
}

/** How many of `op` this member has already used today (from gpt_costs). */
export async function usedToday(userId: string, op: CappedOp): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(gptCosts)
    .where(and(eq(gptCosts.userId, userId), inArray(gptCosts.feature, FEATURES[op]), gte(gptCosts.createdAt, sastDayStart())));
  return Number((row as any)?.n || 0);
}

/**
 * The gate every expensive op calls FIRST. True = go ahead; false = the member has hit today's cap,
 * degrade gracefully. Fail-open on any error (never block value because a count read hiccuped) and
 * when USAGE_CAPS=off. Logs each cap-hit so it's visible in the logs and the cost view.
 */
export async function allowExpensiveOp(userId: string | null | undefined, op: CappedOp): Promise<boolean> {
  // Business-level ceiling first: past the monthly rand cap the expensive ops degrade for
  // everyone, while all deterministic coaching keeps working. See monthlyCeilingHit below.
  if (process.env.USAGE_CAPS !== "off" && await monthlyCeilingHit()) {
    console.warn(`[AI_CEILING] blocked ${op} — monthly rand ceiling reached`);
    return false;
  }
  if (!userId || process.env.USAGE_CAPS === "off") return true;
  try {
    const cap = capFor(op);
    const used = await usedToday(userId, op);
    if (isWithinCap(used, cap)) return true;
    console.warn(`[USAGE_CAP] ${op} cap hit — user=${userId} used=${used}/${cap} today; degrading gracefully.`);
    return false;
  } catch (e) {
    console.warn(`[USAGE_CAP] ${op} check failed (allowing):`, (e as any)?.message || e);
    return true;
  }
}

// MONTHLY RAND CEILING — see server/spend-ceiling.ts for the rationale and the pure decision.
// This half is the DB read: total spend this calendar month across ALL clients, in rand.

/** Total AI spend this calendar month, in rand, across ALL clients. */
export async function monthSpendZar(): Promise<number> {
  const now = new Date(Date.now() + 2 * 3_600_000);              // SAST
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ usd: sql<string>`COALESCE(SUM(${gptCosts.costUsd}), 0)` })
    .from(gptCosts)
    .where(gte(gptCosts.createdAt, monthStart));
  return Number(row?.usd || 0) * usdToZarRate();
}

// Cached so the ceiling check costs one query a minute, not one per message.
let _spendCache: { at: number; zar: number } | null = null;

/**
 * Is total AI spend this month past the ceiling? Fail-OPEN on any error and when no ceiling is
 * configured — a margin guard must never be the reason coaching stops.
 */
export async function monthlyCeilingHit(): Promise<boolean> {
  const ceiling = monthlyCeilingZar();
  if (!ceiling) return false;
  try {
    if (!_spendCache || Date.now() - _spendCache.at > 60_000) {
      _spendCache = { at: Date.now(), zar: await monthSpendZar() };
    }
    const state = ceilingState(_spendCache.zar, ceiling);
    if (state !== "ok") {
      console.warn(`[AI_CEILING] month spend R${_spendCache.zar.toFixed(0)} of R${ceiling} — ${state}`);
    }
    return state === "over";
  } catch {
    return false;
  }
}
