/**
 * Business Health route — real "are we making money?" view for a non-technical founder.
 *
 * Unlike /api/dashboard/revenue (which uses a fixed R43/user cost guess), this pulls
 * ACTUAL AI spend from gpt_costs and surfaces a plain-language "money in vs out /
 * break-even / what's breaking / what to do" picture. Costs that can't be measured
 * (hosting, WhatsApp per-user, FX rate) are env-tunable and shown transparently as
 * assumptions, so nothing is a hidden magic number.
 *
 * Read-only. Touches no billing/payment logic.
 */

import type { Express } from "express";
import { db } from "../db";
import { users, gptCosts, chatHistory } from "../../shared/schema";
import { eq, gte, sql, count } from "drizzle-orm";
import { PRICING, calculateMRR, calculateTrialConversion } from "../../shared/pricing";
import { requireAdminKey } from "./auth";
import { WHATSAPP_ZAR_PER_MSG, BILLABLE_MSGS_SQL } from "../cost-tracking";

interface FinanceAlert {
  level: "good" | "warn" | "bad";
  title: string;
  detail: string;
  action: string;
}

export function registerFinanceRoutes(app: Express): void {
  app.get("/api/dashboard/finance", requireAdminKey, async (_req, res) => {
    try {
      // ── Subscribers ──
      const [paying] = await db.select({ c: count() }).from(users).where(eq(users.subscriptionStatus, "active"));
      const [trial] = await db.select({ c: count() }).from(users).where(eq(users.subscriptionStatus, "trial"));
      const [cancelled] = await db.select({ c: count() }).from(users).where(eq(users.subscriptionStatus, "inactive"));
      const [total] = await db.select({ c: count() }).from(users);
      const payingCount = paying.c || 0;
      const trialCount = trial.c || 0;
      const cancelledCount = cancelled.c || 0;
      const totalCount = total.c || 0;
      const activeAll = payingCount + trialCount;

      // ── Tunable cost assumptions (env overrides, sensible SA defaults) ──
      const USD_ZAR = Number(process.env.USD_ZAR_RATE) || 18.5;
      const HOSTING_ZAR = Number(process.env.FINANCE_HOSTING_ZAR_PER_MONTH) || 400;        // Railway + misc fixed
      // WhatsApp cost comes from REAL message volume at the ONE shared rate (cost-tracking.ts).
      // This used to be a flat R8/user/month modelled on Twilio's per-CONVERSATION bundles, while
      // cost-tracking.ts already billed per message — two assumptions, two answers, same client.
      // From 1 Oct 2026 per-message is the real shape, so the per-user figure was not just
      // imprecise, it was the wrong unit. FINANCE_WHATSAPP_ZAR_PER_USER is retired; tune
      // WHATSAPP_ZAR_PER_MSG instead when the rate card lands.
      if (process.env.FINANCE_WHATSAPP_ZAR_PER_USER) {
        console.warn("[finance] FINANCE_WHATSAPP_ZAR_PER_USER is retired and ignored — set WHATSAPP_ZAR_PER_MSG (per message) instead.");
      }
      const PAYFAST_PCT = Number(process.env.PAYFAST_FEE_PCT) || 0.03;
      const PAYFAST_FIXED = Number(process.env.PAYFAST_FEE_FIXED_ZAR) || 1.5;
      const price = PRICING.monthlyPriceZAR;

      // ── REAL AI spend this calendar month, grouped by feature ──
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const aiRows = await db
        .select({
          feature: gptCosts.feature,
          usd: sql<string>`COALESCE(SUM(${gptCosts.costUsd}), 0)`,
        })
        .from(gptCosts)
        .where(gte(gptCosts.createdAt, monthStart))
        .groupBy(gptCosts.feature);
      const aiTotalUsd = aiRows.reduce((s, row) => s + Number(row.usd || 0), 0);
      const aiCostZar = aiTotalUsd * USD_ZAR;
      const aiByFeature = aiRows
        .map(row => ({ feature: row.feature || "other", zar: Math.round(Number(row.usd || 0) * USD_ZAR) }))
        .filter(row => row.zar > 0)
        .sort((a, b) => b.zar - a.zar);

      // ── Money out ──
      // Real billable messages this month — inbound + every outbound bubble, not exchanges.
      const [msgAgg] = await db.select({ n: BILLABLE_MSGS_SQL })
        .from(chatHistory).where(gte(chatHistory.createdAt, monthStart));
      const billableMsgs = Number((msgAgg as any)?.n || 0);
      const whatsappZar = billableMsgs * WHATSAPP_ZAR_PER_MSG;
      const payfastZar = payingCount * (price * PAYFAST_PCT + PAYFAST_FIXED);
      const totalCost = aiCostZar + whatsappZar + payfastZar + HOSTING_ZAR;

      // ── Money in & profit ──
      const mrr = calculateMRR(payingCount);
      const trialConversion = calculateTrialConversion(trialCount, payingCount);
      const projectedNewPaying = Math.round(trialCount * trialConversion / 100);
      const projectedMRR = calculateMRR(payingCount + projectedNewPaying);
      const netProfit = mrr - totalCost;
      const margin = mrr > 0 ? Math.round((netProfit / mrr) * 100) : 0;
      const estimatedMonthlyChurn = totalCount > 0
        ? Math.round(Math.max(0.05, cancelledCount / Math.max(1, cancelledCount + payingCount)) * 100)
        : 15;

      // ── Break-even (the number a non-technical founder most needs) ──
      const aiPerActive = activeAll > 0 ? aiCostZar / activeAll : 0;
      const waPerActive = activeAll > 0 ? whatsappZar / activeAll : 0;
      const variablePerPaying = aiPerActive + waPerActive + (price * PAYFAST_PCT + PAYFAST_FIXED);
      const contributionPerUser = price - variablePerPaying; // profit each paying client adds
      const breakEvenPaying = contributionPerUser > 0 ? Math.ceil(HOSTING_ZAR / contributionPerUser) : null;
      const payingToBreakEven = breakEvenPaying != null ? Math.max(0, breakEvenPaying - payingCount) : null;

      // ── Plain-language alerts: level + what it means + what to do ──
      const r = (n: number) => Math.round(n);
      const alerts: FinanceAlert[] = [];

      if (mrr === 0) {
        alerts.push({ level: "warn", title: "No paying clients yet", detail: `You have ${trialCount} on trial. Revenue starts when the first one converts.`, action: "Focus on converting trials — that's your only revenue lever right now." });
      } else if (netProfit < 0) {
        alerts.push({ level: "bad", title: `Losing R${r(Math.abs(netProfit))} per month`, detail: `Costs (R${r(totalCost)}) are higher than revenue (R${r(mrr)}).`, action: payingToBreakEven ? `Get ${payingToBreakEven} more paying client${payingToBreakEven === 1 ? "" : "s"} to break even.` : `Each client costs more than R${price} — cut AI/WhatsApp cost per user first.` });
      } else if (margin < 40) {
        alerts.push({ level: "warn", title: `Thin profit margin (${margin}%)`, detail: `You keep R${r(netProfit)} of R${r(mrr)} after costs.`, action: "Healthy is 60%+. Grow paying clients (fixed costs spread thinner) or trim cost per user." });
      } else {
        alerts.push({ level: "good", title: `Profitable: +R${r(netProfit)}/month`, detail: `${margin}% margin — you keep R${r(netProfit)} of every R${r(mrr)}.`, action: `Healthy. Keep acquiring clients; each adds ~R${r(contributionPerUser)} profit.` });
      }

      // AI cost per user
      const aiPct = price > 0 ? Math.round((aiPerActive / price) * 100) : 0;
      if (aiPerActive > price * 0.30) {
        alerts.push({ level: "bad", title: `AI costs R${r(aiPerActive)}/user (${aiPct}% of price)`, detail: "GPT spend is eating a big chunk of each subscription.", action: "Cap GPT calls, route more to deterministic handlers, check food-vision usage." });
      } else if (aiPerActive > price * 0.18) {
        alerts.push({ level: "warn", title: `AI costs R${r(aiPerActive)}/user (${aiPct}% of price)`, detail: "Climbing, but not dangerous yet.", action: "Watch the AI breakdown below; trim the biggest feature if it keeps rising." });
      } else {
        alerts.push({ level: "good", title: `AI cost in check (R${r(aiPerActive)}/user)`, detail: `${aiPct}% of your R${price} price.`, action: "No action — AI spend is well within margin." });
      }

      // Trial conversion
      if (trialCount > 0 || payingCount > 0) {
        if (trialConversion < 15) alerts.push({ level: "bad", title: `Low trial conversion (${trialConversion}%)`, detail: "Most trials aren't becoming paying clients.", action: "Strengthen Day 2/5/7 trial messages and the 'first win' moment." });
        else if (trialConversion < 25) alerts.push({ level: "warn", title: `Trial conversion ${trialConversion}%`, detail: "Okay, but there's room.", action: "Aim for 25%+. Test a stronger Day-7 nudge." });
        else alerts.push({ level: "good", title: `Trial conversion ${trialConversion}%`, detail: "Trials are converting well.", action: "No action." });
      }

      // Churn
      if (estimatedMonthlyChurn > 15) alerts.push({ level: "bad", title: `High churn (~${estimatedMonthlyChurn}%/month)`, detail: "Clients are cancelling faster than is sustainable.", action: "Look at why people leave (escalations, NPS) before spending on acquisition." });
      else if (estimatedMonthlyChurn > 8) alerts.push({ level: "warn", title: `Churn ~${estimatedMonthlyChurn}%/month`, detail: "Watch this.", action: "Below 8% is the goal for a coaching subscription." });

      // Pipeline
      if (trialCount === 0 && payingCount > 0) alerts.push({ level: "warn", title: "Empty trial pipeline", detail: "No one is on trial — future growth will stall.", action: "Drive new signups (referrals, the WhatsApp link)." });

      // ── Previous month's AI spend for trend context ──
      const prevMonthStart = new Date(monthStart);
      prevMonthStart.setUTCMonth(prevMonthStart.getUTCMonth() - 1);
      const [prevAi] = await db
        .select({ usd: sql<string>`COALESCE(SUM(${gptCosts.costUsd}), 0)` })
        .from(gptCosts)
        .where(sql`${gptCosts.createdAt} >= ${prevMonthStart} AND ${gptCosts.createdAt} < ${monthStart}`);
      const prevAiCostZar = Number(prevAi?.usd || 0) * USD_ZAR;

      res.json({
        computedAt: new Date().toISOString(),
        currency: PRICING.currency,
        trend: {
          prevMonthAiZar: Math.round(prevAiCostZar),
          thisMonthAiZar: Math.round(aiCostZar),
          aiChange: aiCostZar > 0 && prevAiCostZar > 0
            ? Math.round(((aiCostZar - prevAiCostZar) / prevAiCostZar) * 100)
            : null,
        },
        headline: {
          netProfit: r(netProfit),
          netProfitDisplay: `${netProfit < 0 ? "-" : "+"}R${r(Math.abs(netProfit)).toLocaleString()}`,
          profitable: netProfit >= 0,
          margin,
          revenue: r(mrr),
          totalCost: r(totalCost),
        },
        moneyIn: {
          mrr: r(mrr), mrrDisplay: `R${r(mrr).toLocaleString()}`,
          payingUsers: payingCount, trialUsers: trialCount, totalUsers: totalCount,
          projectedNewPaying, projectedMRR: r(projectedMRR), projectedMRRDisplay: `R${r(projectedMRR).toLocaleString()}`,
          trialConversion,
        },
        moneyOut: {
          total: r(totalCost),
          breakdown: [
            { label: "AI (GPT, vision, voice)", amount: r(aiCostZar), measured: true, note: "Actual spend recorded this month" },
            // `measured: true` now — the message COUNT is real; only the per-message rate is an estimate.
            { label: "WhatsApp (Twilio)", amount: r(whatsappZar), measured: true, note: `${billableMsgs} billable messages × R${WHATSAPP_ZAR_PER_MSG} est. rate` },
            { label: "PayFast fees", amount: r(payfastZar), measured: false, note: `${payingCount} × (${Math.round(PAYFAST_PCT * 100)}% + R${PAYFAST_FIXED})` },
            { label: "Hosting (Railway)", amount: r(HOSTING_ZAR), measured: false, note: "Fixed monthly est." },
          ],
          aiByFeature,
        },
        breakEven: {
          payingNeeded: breakEvenPaying,
          payingNow: payingCount,
          toGo: payingToBreakEven,
          contributionPerUser: r(contributionPerUser),
        },
        assumptions: {
          usdZar: USD_ZAR, hostingZar: HOSTING_ZAR,
          whatsappPerMsg: WHATSAPP_ZAR_PER_MSG, billableMsgs,
          whatsappPerActiveUser: r(activeAll > 0 ? whatsappZar / activeAll : 0),
          payfastPct: Math.round(PAYFAST_PCT * 100), payfastFixed: PAYFAST_FIXED, price,
        },
        alerts,
      });
    } catch (err) {
      console.error("[FINANCE] Error:", err);
      res.status(500).json({ error: "Failed to compute business health" });
    }
  });

  // ── 6-month AI spend history — pulls directly from gpt_costs ──
  app.get("/api/dashboard/finance/history", requireAdminKey, async (_req, res) => {
    try {
      const USD_ZAR = Number(process.env.USD_ZAR_RATE) || 18.5;

      // Build array of the last 6 month-start timestamps (UTC)
      const months: { label: string; start: Date; end: Date }[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setUTCDate(1);
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCMonth(d.getUTCMonth() - i);
        const end = new Date(d);
        end.setUTCMonth(end.getUTCMonth() + 1);
        months.push({
          label: d.toLocaleString("en-ZA", { month: "short", year: "2-digit", timeZone: "UTC" }),
          start: d,
          end,
        });
      }

      const rows = await Promise.all(
        months.map(async (m) => {
          const [row] = await db
            .select({ usd: sql<string>`COALESCE(SUM(${gptCosts.costUsd}), 0)` })
            .from(gptCosts)
            .where(sql`${gptCosts.createdAt} >= ${m.start} AND ${gptCosts.createdAt} < ${m.end}`);
          return {
            label: m.label,
            aiZar: Math.round(Number(row?.usd || 0) * USD_ZAR),
          };
        })
      );

      res.json({ months: rows, usdZar: USD_ZAR });
    } catch (err) {
      console.error("[FINANCE_HISTORY] Error:", err);
      res.status(500).json({ error: "Failed to fetch finance history" });
    }
  });
}
