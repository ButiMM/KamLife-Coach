/**
 * COST-TO-SERVE TRACKER + WHALE ALERT (2026-07-22, from the CFO deep-dive: "a flat R199 against
 * unbounded usage is a structural leak — one heavy member on voice + vision can cost more to serve
 * than they pay. Turn the biggest financial risk into a dashboard number.").
 *
 * OpenAI cost is already logged per member (recordGptCost -> gpt_costs). This adds the two other
 * lines that make a "whale": VOICE (ElevenLabs — the spiky one) and WhatsApp messaging. Voice is
 * logged directly per member; WhatsApp is derived from message volume at query time (no userId at
 * send time, and per-message logging isn't worth the write). costToServeThisMonth sums all three
 * into rand, so a member bleeding margin shows up ranked and flagged.
 *
 * Pure math is unit-tested; the dashboard reads fail-open (a cost read must never break a reply).
 * The SPEND CAP at the bottom is the exception: it fails SAFE (#340).
 */

import { db } from "./db";
import { gptCosts, chatHistory, adminEvents } from "../shared/schema";
import { eq, gte, and, sql, isNotNull } from "drizzle-orm";
import { PRICING } from "../shared/pricing";
import { sastDayStart } from "./utils";

// ── Rate assumptions (estimates until real invoices land — see the finance deep-dive) ──
export const USD_ZAR = 18.5;                       // same rate the north-star endpoint uses
export const PRICE_ZAR = PRICING.monthlyPriceZAR;  // canonical monthly subscription (shared/pricing.ts)
// ElevenLabs ~US$0.30 per 1,000 characters on the creator tiers (estimate).
const VOICE_USD_PER_CHAR = 0.30 / 1000;
/**
 * A WhatsApp business message ≈ R0.30 all-in (Meta per-message + Twilio markup, blended estimate).
 * EXPORTED and env-tunable (2026-08-13) because finance.ts held a SECOND, contradictory assumption
 * — a flat R8 per user per month, modelled on Twilio's old per-CONVERSATION bundles. From
 * 1 Oct 2026 service messages bill per message, so the two would have given different answers about
 * the same client and the per-user one would have been the wrong shape. One owner, one rate, and it
 * moves with a Railway variable when the real rate card lands.
 */
export const WHATSAPP_ZAR_PER_MSG = Number(process.env.WHATSAPP_ZAR_PER_MSG) || 0.30;

/**
 * BILLABLE MESSAGES IN ONE chat_history ROW. A row is an EXCHANGE, not a message: it holds
 * `messageIn` AND `messageOut`. So `COUNT(*)` — what this file used to do — undercounted by about
 * half, because Twilio bills inbound and outbound separately. Worse, `\n\n---\n\n` splits one
 * `messageOut` into several real WhatsApp sends (a programme is 3, a meal plan 4), each billed.
 * Undercounting cost is the dangerous direction here: it hides whales, and a founder deciding
 * whether R199 survives needs the number to be too high rather than too low.
 */
export function billableMessages(messageIn: string | null, messageOut: string | null): number {
  const inbound = messageIn ? 1 : 0;
  const outbound = messageOut ? messageOut.split("\n\n---\n\n").length : 0;
  return inbound + outbound;
}

/**
 * The SQL that counts the same thing server-side, so a month of rows is not dragged into memory.
 * Kept beside `billableMessages` deliberately: they are one rule and a drifting pair would put the
 * dashboard and the tests in disagreement about the same client.
 */
export const BILLABLE_MSGS_SQL = sql<number>`COALESCE(SUM(
  (CASE WHEN ${chatHistory.messageIn} IS NOT NULL THEN 1 ELSE 0 END)
  + (CASE WHEN ${chatHistory.messageOut} IS NOT NULL
      THEN 1 + (LENGTH(${chatHistory.messageOut}) - LENGTH(REPLACE(${chatHistory.messageOut}, E'\n\n---\n\n', ''))) / 7
      ELSE 0 END)
), 0)::int`

/** USD cost of voicing `charCount` characters through ElevenLabs. */
export function voiceCostUsd(charCount: number): number {
  return Math.max(0, charCount) * VOICE_USD_PER_CHAR;
}

/**
 * VISION — the other half of the whale (2026-09-03). Moved here from gpt.ts, which never called
 * these and never referenced them: gpt.ts owns TALKING to the model, and this pair owns what a
 * member is entitled to spend on a photo and what that photo costs us. `voiceCostUsd` above is
 * the same shape for the other expensive operation, and splitting the price of a decision from
 * the decision that fixes it would give two files a say in one number.
 */
export type VisionUseCase = "food_photo" | "progress_compare" | "exercise_classify" | "step_ocr";
export type SubscriptionTier = "active" | "trial" | "inactive" | string | null | undefined;

export interface VisionModelDecision {
  allowed: boolean;
  model: "gpt-4o" | "gpt-4o-mini";
  detail: "low" | "auto" | "high";
  maxTokens: number;
  reason: string;
}

export function selectVisionModel(useCase: VisionUseCase, tier: SubscriptionTier): VisionModelDecision {
  const t = (tier || "").toLowerCase();
  const paying = t === "active";
  const onboarded = paying || t === "trial";

  if (!onboarded) {
    return {
      allowed: false,
      model: "gpt-4o-mini",
      detail: "low",
      maxTokens: 0,
      reason: "inactive_tier_blocked",
    };
  }

  switch (useCase) {
    case "progress_compare":
      return paying
        ? { allowed: true, model: "gpt-4o", detail: "auto", maxTokens: 400, reason: "progress_paid" }
        : { allowed: true, model: "gpt-4o-mini", detail: "auto", maxTokens: 350, reason: "progress_trial" };

    case "food_photo":
      // gpt-4o for paying users — better SA food recognition, fewer "cannot make out" failures
      return paying
        ? { allowed: true, model: "gpt-4o", detail: "auto", maxTokens: 400, reason: "food_paid" }
        : { allowed: true, model: "gpt-4o-mini", detail: "auto", maxTokens: 400, reason: "food_trial" };

    case "exercise_classify":
    case "step_ocr":
      return { allowed: true, model: "gpt-4o-mini", detail: "low", maxTokens: useCase === "step_ocr" ? 50 : 8, reason: useCase };
  }
}

export function estimateVisionCostUSD(decision: VisionModelDecision, completionTokens: number = 0): number {
  const imgTok = decision.detail === "low" ? 85 : decision.detail === "high" ? 400 : 170;
  const promptTok = imgTok + 300;
  if (decision.model === "gpt-4o-mini") {
    return (promptTok * 0.15 + completionTokens * 0.6) / 1_000_000;
  }
  return (promptTok * 5 + completionTokens * 15) / 1_000_000;
}

/**
 * Log a non-token service cost (voice, etc.) against a member, reusing the gpt_costs table so it
 * flows into the same per-member/date index and the north-star view. Fire-and-forget.
 */
export function recordServiceCost(opts: { userId?: string | null; feature: string; costUsd: number }): void {
  if (!opts.userId || !(opts.costUsd > 0)) return;
  db.insert(gptCosts).values({
    userId: opts.userId,
    model: "service",
    feature: opts.feature,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: opts.costUsd.toFixed(6),
  }).catch(e => console.warn("[cost] service insert failed (non-fatal):", (e as any)?.message || e));
}

export interface MemberCost {
  userId: string;
  aiZar: number;        // OpenAI + voice (everything in gpt_costs)
  whatsappZar: number;  // derived from outbound message volume
  totalZar: number;     // cost to serve, month-to-date
  marginZar: number;    // PRICE_ZAR − totalZar
  whale: boolean;       // serving them costs more than a safe share of their fee
}

/** The rand threshold above which a member's month-to-date cost-to-serve is a concern. Half the
 *  fee — beyond this, contribution margin is thinner than the business can carry at scale. */
export const WHALE_THRESHOLD_ZAR = PRICE_ZAR * 0.5;

/** PURE — assemble a member's cost row from its parts. Whale = cost-to-serve over the threshold. */
export function memberCostRow(userId: string, aiUsd: number, whatsappMsgs: number): MemberCost {
  const aiZar = Math.round(aiUsd * USD_ZAR * 100) / 100;
  const whatsappZar = Math.round(whatsappMsgs * WHATSAPP_ZAR_PER_MSG * 100) / 100;
  const totalZar = Math.round((aiZar + whatsappZar) * 100) / 100;
  return {
    userId, aiZar, whatsappZar, totalZar,
    marginZar: Math.round((PRICE_ZAR - totalZar) * 100) / 100,
    whale: totalZar > WHALE_THRESHOLD_ZAR,
  };
}

const monthStart = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); };

/** Per-member cost-to-serve for the current calendar month (userId -> MemberCost). Read-only. */
export async function costToServeThisMonth(): Promise<Map<string, MemberCost>> {
  const since = monthStart();
  const [aiRows, msgRows] = await Promise.all([
    db.select({ userId: gptCosts.userId, usd: sql<string>`COALESCE(SUM(${gptCosts.costUsd}),0)` })
      .from(gptCosts).where(and(isNotNull(gptCosts.userId), gte(gptCosts.createdAt, since))).groupBy(gptCosts.userId),
    db.select({ userId: chatHistory.userId, n: BILLABLE_MSGS_SQL })
      .from(chatHistory).where(and(isNotNull(chatHistory.userId), gte(chatHistory.createdAt, since))).groupBy(chatHistory.userId),
  ]);
  const msgMap = new Map(msgRows.filter(r => r.userId).map(r => [r.userId as string, Number(r.n)]));
  const out = new Map<string, MemberCost>();
  for (const r of aiRows) {
    if (!r.userId) continue;
    out.set(r.userId, memberCostRow(r.userId, parseFloat(r.usd || "0"), msgMap.get(r.userId) || 0));
  }
  // Members with messages but no AI cost yet still get a (WhatsApp-only) row.
  for (const [userId, n] of msgMap) if (!out.has(userId)) out.set(userId, memberCostRow(userId, 0, n));
  return out;
}

/** One member's cost-to-serve, for the client file. Fail-open to null. */
export async function memberCostThisMonth(userId: string): Promise<MemberCost | null> {
  try {
    const since = monthStart();
    const [ai, msgs] = await Promise.all([
      db.select({ usd: sql<string>`COALESCE(SUM(${gptCosts.costUsd}),0)` }).from(gptCosts).where(and(eq(gptCosts.userId, userId), gte(gptCosts.createdAt, since))),
      db.select({ n: BILLABLE_MSGS_SQL }).from(chatHistory).where(and(eq(chatHistory.userId, userId), gte(chatHistory.createdAt, since))),
    ]);
    return memberCostRow(userId, parseFloat(ai[0]?.usd || "0"), Number((msgs[0] as any)?.n || 0));
  } catch (e) {
    console.warn("[cost] member cost read failed:", (e as any)?.message || e);
    return null;
  }
}

/**
 * THE SPEND CAP FAILS SAFE (#340). A cost query that errors used to mean "no limit", so a failing
 * query plus a public number anyone can message meant unbounded OpenAI spend. Now:
 *   - the account-wide daily ceiling (GLOBAL_AI_DAILY_HARD_CAP_USD, defaulting to the watchdog's
 *     soft cap) is a HARD stop, checked before the per-client limits and cached for a minute;
 *   - any error reading spend counts as "over", so the client gets the short degraded reply the
 *     cap already has, never an unbounded model call;
 *   - each distinct failure is recorded once an hour in admin_events for the founder's view.
 */
const capAlertedAt = new Map<string, number>();
async function recordCapEvent(action: string, reason: string, meta: Record<string, unknown> = {}): Promise<void> {
  const last = capAlertedAt.get(action) ?? 0;
  if (Date.now() - last < 3600_000) return;
  capAlertedAt.set(action, Date.now());
  console.error(`[AI_SPEND_CAP] ${action}: ${reason}`);
  await db.insert(adminEvents).values({ action, reason, meta }).catch(() => {});
}
let globalCapCache: { at: number; ok: boolean } | null = null;
export function _resetSpendCapCache(): void { globalCapCache = null; capAlertedAt.clear(); }
export async function isUnderGlobalDailyCap(): Promise<boolean> {
  if (globalCapCache && Date.now() - globalCapCache.at < 60_000) return globalCapCache.ok;
  const raw = parseFloat(process.env.GLOBAL_AI_DAILY_HARD_CAP_USD || process.env.GLOBAL_AI_DAILY_SOFT_CAP_USD || "15");
  const capUsd = isFinite(raw) && raw > 0 ? raw : 15;
  let ok: boolean;
  try {
    const r = await db.select({ total: sql<string>`COALESCE(SUM(cost_usd::numeric), 0)` }).from(gptCosts).where(gte(gptCosts.createdAt, sastDayStart()));
    const spent = parseFloat(r[0]?.total || "0");
    ok = spent < capUsd;
    if (!ok) await recordCapEvent("ai_spend_global_cap_hit", `spent $${spent.toFixed(2)} today, ceiling $${capUsd}`, { spent, capUsd });
  } catch (e) {
    ok = false;
    await recordCapEvent("ai_spend_cap_unreadable", `cost query failed: ${(e as Error)?.message || e}`);
  }
  globalCapCache = { at: Date.now(), ok };
  return ok;
}

export async function isUnderGPTCallLimit(userId: string): Promise<boolean> {
  if (!(await isUnderGlobalDailyCap())) return false;
  try {
    const todayStart = sastDayStart();
    const result = await db.select({ count: sql`count(*)` })
      .from(chatHistory)
      .where(and(
        eq(chatHistory.userId, userId),
        gte(chatHistory.createdAt, todayStart),
        sql`message_in IS NOT NULL AND message_in != ''`
      ));
    const count = parseInt(String(result[0]?.count || 0));
    // 40 locked out a stress-testing (voice-heavy) client mid-conversation. 80 mini
    // replies ≈ $0.09/day worst case — the monthly $ cap below is the real margin guard.
    if (count >= 80) return false;
    // Monthly AI spend cap — env var AI_SPEND_CAP_USD_PER_USER_PER_MONTH (default $5)
    // Prevents a single power user from consuming more than the revenue they generate.
    return isUnderMonthlyCostCap(userId);
  } catch (e) {
    await recordCapEvent("ai_spend_cap_unreadable", `call-count query failed: ${(e as Error)?.message || e}`);
    return false; // fail SAFE (#340): the short degraded reply, never an unbounded model call
  }
}

async function isUnderMonthlyCostCap(userId: string): Promise<boolean> {
  const capUsd = parseFloat(process.env.AI_SPEND_CAP_USD_PER_USER_PER_MONTH || "5");
  if (!isFinite(capUsd) || capUsd <= 0) return true; // cap disabled
  try {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const result = await db.select({ total: sql<string>`COALESCE(SUM(cost_usd::numeric), 0)` })
      .from(gptCosts)
      .where(and(
        eq(gptCosts.userId, userId),
        gte(gptCosts.createdAt, monthStart),
      ));
    const spent = parseFloat(result[0]?.total || "0");
    if (spent >= capUsd) {
      console.warn(`[AI_SPEND_CAP] user ...${userId.slice(-6)} hit $${capUsd} cap (spent $${spent.toFixed(4)} this month)`);
      return false;
    }
    return true;
  } catch (e) {
    await recordCapEvent("ai_spend_cap_unreadable", `monthly cost query failed: ${(e as Error)?.message || e}`);
    return false; // fail SAFE (#340): the short degraded reply, never an unbounded model call
  }
}
