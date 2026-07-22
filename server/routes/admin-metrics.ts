import type { Express } from "express";
import { db } from "../db";
import { gptCosts } from "../../shared/schema";
import { gte } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { requireAdminKey } from "./auth";

// North-star metrics (2026-07-14) — extracted from admin.ts for the file-size budget.
// The money + engagement + quality layer the VC review asked for. Detailed funnel/
// retention live at /api/dashboard/funnel; this is the CFO + habit + quality view.
export function registerAdminMetrics(app: Express) {
  // ── NORTH-STAR METRICS (2026-07-14, VC review: "measure everything, publish it
  // internally — without numbers everything sounds theoretical"). ONE consolidated
  // view of the needles the founder actually moves: unit economics (MRR, AI cost per
  // paying user, gross margin), engagement (DAU/WAU/MAU, stickiness), activation, and
  // product quality (fumbles from quality_signals). Detailed retention/funnel already
  // live at /api/dashboard/funnel — this is the money + engagement + quality layer. ──
  app.get("/api/admin/north-star", requireAdminKey, async (_req, res) => {
    try {
      const PRICE_ZAR = 199;      // current subscription price
      const USD_ZAR = 18.5;       // same rate the cost logger uses
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const [aggR, costRow, activatedR, qualityRows] = await Promise.all([
        db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE subscription_status = 'active')::int                    AS paying,
            COUNT(*) FILTER (WHERE onboarding_state = 'COMPLETE')::int                     AS onboarded,
            COUNT(*) FILTER (WHERE last_active_at >= NOW() - INTERVAL '1 day')::int         AS dau,
            COUNT(*) FILTER (WHERE last_active_at >= NOW() - INTERVAL '7 days')::int        AS wau,
            COUNT(*) FILTER (WHERE last_active_at >= NOW() - INTERVAL '30 days')::int       AS mau
          FROM users
        `),
        db.select({ usd: sql<string>`coalesce(sum(cost_usd), 0)` }).from(gptCosts).where(gte(gptCosts.createdAt, monthStart)),
        db.execute(sql`
          SELECT COUNT(DISTINCT u.id)::int AS activated
          FROM users u
          WHERE u.onboarding_state = 'COMPLETE'
            AND (u.total_workouts_completed >= 1 OR EXISTS (SELECT 1 FROM meal_logs m WHERE m.user_id = u.id))
        `),
        db.execute(sql`
          SELECT kind, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE reviewed)::int AS reviewed
          FROM quality_signals
          WHERE created_at >= NOW() - INTERVAL '7 days' AND kind NOT LIKE 'friction_%'
          GROUP BY kind
        `),
      ]);

      const a = (aggR.rows[0] || {}) as Record<string, number>;
      const paying = Number(a.paying || 0);
      const onboarded = Number(a.onboarded || 0);
      const dau = Number(a.dau || 0), wau = Number(a.wau || 0), mau = Number(a.mau || 0);
      const activated = Number((activatedR.rows[0] as any)?.activated || 0);

      const aiCostZar = Math.round(parseFloat(costRow[0]?.usd || "0") * USD_ZAR * 100) / 100;
      const mrrZar = paying * PRICE_ZAR;
      const aiCostPerPayingZar = paying > 0 ? Math.round(aiCostZar / paying * 100) / 100 : null;
      // AI-only gross margin (Twilio/WhatsApp NOT included — flagged so it isn't read as final).
      const grossMarginAiOnlyPct = mrrZar > 0 ? Math.round((mrrZar - aiCostZar) / mrrZar * 100) : null;

      const fumbles7d = (qualityRows.rows as any[]).map(r => ({ kind: r.kind, count: Number(r.n), reviewed: Number(r.reviewed) }));
      const totalFumbles = fumbles7d.reduce((s, f) => s + f.count, 0);

      res.json({
        computedAt: now.toISOString(),
        readIt: "The money layer + engagement + quality. Watch: gross margin (protect it), DAU/MAU stickiness (habit forming?), activation % (the first-action rate the VC says matters most), and fumbles trending DOWN week over week. AI margin excludes Twilio — treat it as a ceiling.",
        unitEconomics: {
          payingMembers: paying,
          mrrZar,
          aiCostThisMonthZar: aiCostZar,
          aiCostPerPayingMemberZar: aiCostPerPayingZar,
          grossMarginAiOnlyPct,
          note: "grossMargin excludes Twilio/WhatsApp + PayFast fees — it's an upper bound on margin, not the final number.",
        },
        engagement: {
          dau, wau, mau,
          stickinessPct: mau > 0 ? Math.round(dau / mau * 100) : null, // DAU/MAU — the habit signal
          onboarded,
          activatedMembers: activated,
          activationRatePct: onboarded > 0 ? Math.round(activated / onboarded * 100) : null,
          activationNote: "activated = onboarded AND took a first real action (a workout or a meal logged), lifetime — not yet time-boxed to the first 48h.",
        },
        quality: {
          fumblesLast7d: totalFumbles,
          byKind: fumbles7d,
          note: "Fewer fumbles week over week = the product is getting less confusing. Recurring kinds are your next regression cases.",
        },
      });
    } catch (err) {
      console.error("[NORTH_STAR]", err);
      res.status(500).json({ message: "Failed to compute north-star metrics" });
    }
  });
}
