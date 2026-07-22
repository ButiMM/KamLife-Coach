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
