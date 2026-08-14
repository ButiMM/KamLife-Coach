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
 * Pure math is unit-tested; the DB reads fail-open (a cost read must never break a reply).
 */

import { db } from "./db";
import { gptCosts, chatHistory } from "../shared/schema";
import { eq, gte, and, sql, isNotNull } from "drizzle-orm";
import { PRICING } from "../shared/pricing";

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
