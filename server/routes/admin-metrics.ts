import type { Express } from "express";
import { db } from "../db";
import { gptCosts, adminEvents } from "../../shared/schema";
import { splitWhatsAppBody } from "../utils";
import { TEMPLATES } from "../whatsapp-templates";
import { gte } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { requireAdminKey } from "./auth";
import { PRICING } from "../../shared/pricing";

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
      const PRICE_ZAR = PRICING.monthlyPriceZAR; // the billing owner (#567), never a second copy
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

  // ── EVIDENCE (#506): read-only, for the price/channel decision and the proof gate. Real usage per
  // active client, a sample of the final replies with their source and build, and the approved
  // templates actually sent. Nothing leaves production; every read is audited like a turn read. ──
  app.get("/api/admin/evidence", requireAdminKey, async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
      const n = Math.min(100, Math.max(1, Number(req.query.n) || 30));
      const since = sql`now() - make_interval(days => ${days})`;
      const [inbound, replies, proactive, sample, loop] = await Promise.all([
        db.execute(sql`SELECT user_id::text u, count(*)::int n FROM chat_history
          WHERE created_at >= ${since} AND message_in IS NOT NULL AND message_in <> ''
            AND message_in NOT LIKE '[system]%' AND message_in NOT LIKE '[admin%' GROUP BY 1`),
        db.execute(sql`SELECT user_id::text u, delivered_body b, input_type t FROM turn_ledger
          WHERE created_at >= ${since} AND user_id IS NOT NULL`),
        db.execute(sql`SELECT user_id::text u, message_out b FROM chat_history
          WHERE created_at >= ${since} AND message_in IS NULL AND intent IN ('PROACTIVE', 'PROACTIVE_SUBSTITUTED')`),
        db.execute(sql`SELECT t.created_at at, right(u.phone_number, 3) phone, left(t.input_text, 300) inbound,
            left(t.delivered_body, 1500) reply, t.decision->>'source' source, t.version, t.delivery_outcome outcome
          FROM turn_ledger t LEFT JOIN users u ON u.id = t.user_id
          WHERE t.delivered_body IS NOT NULL ORDER BY t.created_at DESC LIMIT ${n}`),
        // THE COMMITMENT LOOP, PER WEEK (A19, spec §7): each promise once, by what became of it.
        db.execute(sql`SELECT date_trunc('week', c.created_at)::date week, count(*)::int accepted,
            count(*) FILTER (WHERE c.detail->>'state' = 'kept' OR o.detail->>'outcome' = 'kept')::int kept,
            count(*) FILTER (WHERE o.detail->>'outcome' = 'missed')::int missed,
            count(*) FILTER (WHERE c.superseded_by IS NULL AND c.valid_until < now() AND c.detail->>'state' <> 'kept')::int released,
            count(*) FILTER (WHERE c.detail->>'state' = 'asked')::int followed_up
          FROM client_facts c LEFT JOIN client_facts o ON o.id = c.superseded_by AND o.detail ? 'outcome'
          WHERE c.kind = 'commitment' AND NOT (c.detail ? 'outcome') AND c.created_at >= ${since} GROUP BY 1 ORDER BY 1`),
      ]);
      const per = new Map<string, EvidenceCounts>();
      const at = (u: string) => per.get(u) ?? per.set(u, { inbound: 0, outboundBubbles: 0, proactive: 0, templates: 0, media: 0 }).get(u)!;
      for (const r of inbound.rows as any[]) at(r.u).inbound = Number(r.n);
      for (const r of replies.rows as any[]) {
        if (r.b) at(r.u).outboundBubbles += splitWhatsAppBody(String(r.b)).length;
        if (r.t && r.t !== "text") at(r.u).media++;
      }
      const templateSends: Record<string, number> = {};
      for (const r of proactive.rows as any[]) {
        const c = at(r.u);
        c.proactive++;
        c.outboundBubbles += splitWhatsAppBody(String(r.b || "")).length;
        const name = templateOf(String(r.b || ""));
        if (name) { c.templates++; templateSends[name] = (templateSends[name] || 0) + 1; }
      }
      await db.insert(adminEvents).values({ action: "evidence_read", reason: "evidence view (#506)", meta: { days, n, clients: per.size } })
        .catch((e: any) => console.warn("[EVIDENCE] audit write failed:", e?.message));
      res.json({
        computedAt: new Date().toISOString(), days, activeClients: per.size,
        usagePerClient: summariseUsage([...per.values()]),
        templates: TEMPLATES.map(t => ({ name: t.name, category: t.category, sends: templateSends[t.name] || 0 })),
        finalReplies: sample.rows,
        commitmentLoop: loop.rows,
        readIt: "usagePerClient is per active client over the window (median, p90, max). Bubbles are the WhatsApp messages actually billed (#492 packs up to 1,500 characters). finalReplies are the last delivered bodies with their source and build; phones show the last 3 digits only. commitmentLoop counts each promise once per week by what became of it: kept (the ledger or their word), missed, released (lapsed unanswered) or followed up.",
      });
    } catch (err) {
      console.error("[EVIDENCE]", err);
      res.status(500).json({ message: "Failed to compute evidence" });
    }
  });
}

export interface EvidenceCounts { inbound: number; outboundBubbles: number; proactive: number; templates: number; media: number }

/** Median, 90th percentile and max of each count across clients (nearest-rank). */
export function summariseUsage(clients: EvidenceCounts[]) {
  const stat = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const rank = (p: number) => s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0;
    return { median: rank(0.5), p90: rank(0.9), max: s.length ? s[s.length - 1] : 0 };
  };
  const keys: (keyof EvidenceCounts)[] = ["inbound", "outboundBubbles", "proactive", "templates", "media"];
  return Object.fromEntries(keys.map(k => [k, stat(clients.map(c => c[k]))]));
}

/**
 * Which approved template a logged proactive body is, if any. The send path logs the rendered body,
 * not the name, so a body matches a template when it holds every fixed stretch of that template's text,
 * in order, around the {{n}} slots.
 */
export function templateOf(text: string): string | null {
  for (const t of TEMPLATES) {
    const parts = t.body.split("{{").map((p, i) => (i === 0 ? p : p.slice(p.indexOf("}}") + 2))).filter(p => p.trim());
    let from = 0;
    if (parts.length && parts.every(p => { const i = text.indexOf(p, from); if (i < 0) return false; from = i + p.length; return true; })) return t.name;
  }
  return null;
}
