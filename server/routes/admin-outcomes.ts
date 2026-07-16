import type { Express } from "express";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { requireAdminKey } from "./auth";

/**
 * HEALTH-OUTCOME METRICS (Law 17 — the gap both 2026-07-16 reviewers flagged).
 *
 * The north-star endpoint measures money, engagement and quality. But investors — and we —
 * ultimately care about OUTCOMES: do KamLife clients actually lose weight, show up, and log
 * consistently? Conversation quality is worthless if behaviour doesn't change. This is that
 * view: deterministic aggregation over real data (weights, workouts, meals, check-ins,
 * escalations) — no AI, no guesses. Read-only, admin-gated. Built before the closed beta so
 * we launch on evidence, not vibes.
 *
 * Cohort = onboarded clients (onboarding_state = COMPLETE). "Active" = last_active_at within
 * 14 days. All windows are rolling.
 */
export function registerAdminOutcomes(app: Express) {
  app.get("/api/admin/outcomes", requireAdminKey, async (_req, res) => {
    try {
      const now = new Date();

      const [weightR, adherenceR, retentionR, escalationR] = await Promise.all([
        // Weight movement in the client's GOAL direction, from first→latest weigh-in.
        db.execute(sql`
          WITH w AS (
            SELECT user_id,
                   (array_agg(weight ORDER BY logged_at ASC))[1]  AS first_w,
                   (array_agg(weight ORDER BY logged_at DESC))[1] AS last_w
            FROM weight_logs GROUP BY user_id HAVING COUNT(*) >= 2
          ),
          j AS (
            SELECT u.goal_type, (w.last_w - w.first_w) AS delta
            FROM w JOIN users u ON u.id = w.user_id
            WHERE u.onboarding_state = 'COMPLETE'
          )
          SELECT
            COUNT(*)::int AS clients_with_trend,
            ROUND(AVG(ABS(delta))::numeric, 1) AS avg_abs_change_kg,
            ROUND(AVG(delta)::numeric, 1)      AS avg_signed_change_kg,
            COUNT(*) FILTER (
              WHERE (goal_type = 'fat_loss'    AND delta <= -0.3)
                 OR (goal_type = 'muscle_gain' AND delta >=  0.3)
                 OR (goal_type NOT IN ('fat_loss','muscle_gain') AND ABS(delta) <= 1.0)
            )::int AS moving_right_direction
          FROM j
        `),
        // Adherence over the last 4 weeks, across active onboarded clients.
        db.execute(sql`
          WITH cohort AS (
            SELECT id FROM users
            WHERE onboarding_state = 'COMPLETE' AND last_active_at >= NOW() - INTERVAL '14 days'
          )
          SELECT
            (SELECT COUNT(*) FROM cohort)::int AS active_clients,
            (SELECT COUNT(DISTINCT w.user_id) FROM workout_logs w
               JOIN cohort c ON c.id = w.user_id
               WHERE w.workout_completed = true AND w.logged_at >= NOW() - INTERVAL '7 days')::int AS trained_this_week,
            (SELECT COUNT(DISTINCT m.user_id) FROM meal_logs m
               JOIN cohort c ON c.id = m.user_id
               WHERE m.logged_at >= NOW() - INTERVAL '7 days')::int AS logged_food_this_week,
            (SELECT COUNT(DISTINCT ch.user_id) FROM weekly_checkins ch
               JOIN cohort c ON c.id = ch.user_id
               WHERE ch.week_start_date >= (NOW() - INTERVAL '7 days')::date)::int AS checked_in_this_week
        `),
        // Retention: of clients who joined ≥N days ago, how many are still active (14d).
        db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '30 days')::int  AS eligible_30d,
            COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '30 days'  AND last_active_at >= NOW() - INTERVAL '14 days')::int AS retained_30d,
            COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '90 days')::int  AS eligible_90d,
            COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '90 days'  AND last_active_at >= NOW() - INTERVAL '14 days')::int AS retained_90d,
            COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '180 days')::int AS eligible_180d,
            COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '180 days' AND last_active_at >= NOW() - INTERVAL '14 days')::int AS retained_180d
          FROM users WHERE onboarding_state = 'COMPLETE'
        `),
        // Human-escalation rate over the last 30 days.
        db.execute(sql`
          SELECT
            COUNT(*)::int AS escalations_30d,
            COUNT(DISTINCT user_id)::int AS clients_escalated_30d
          FROM escalations WHERE created_at >= NOW() - INTERVAL '30 days'
        `),
      ]);

      const w = (weightR.rows[0] || {}) as Record<string, any>;
      const a = (adherenceR.rows[0] || {}) as Record<string, any>;
      const r = (retentionR.rows[0] || {}) as Record<string, any>;
      const e = (escalationR.rows[0] || {}) as Record<string, any>;

      const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : null);
      const active = Number(a.active_clients || 0);

      res.json({
        computedAt: now.toISOString(),
        readIt: "The outcome layer — do clients actually get healthier? Watch: % moving in their goal direction (the real product test), weekly adherence (train/log/check-in), retention at 30/90/180d, and escalation rate LOW. These are what a closed beta must prove before public launch.",
        weight: {
          clientsWithTrend: Number(w.clients_with_trend || 0),
          avgAbsChangeKg: w.avg_abs_change_kg != null ? Number(w.avg_abs_change_kg) : null,
          avgSignedChangeKg: w.avg_signed_change_kg != null ? Number(w.avg_signed_change_kg) : null,
          movingRightDirection: Number(w.moving_right_direction || 0),
          movingRightPct: pct(Number(w.moving_right_direction || 0), Number(w.clients_with_trend || 0)),
          note: "Right direction = fat_loss down ≥0.3kg, muscle_gain up ≥0.3kg, recomp within ±1kg. Needs ≥2 weigh-ins.",
        },
        adherence: {
          activeClients: active,
          trainedThisWeekPct: pct(Number(a.trained_this_week || 0), active),
          loggedFoodThisWeekPct: pct(Number(a.logged_food_this_week || 0), active),
          checkedInThisWeekPct: pct(Number(a.checked_in_this_week || 0), active),
          note: "Share of active (14d) clients who trained / logged a meal / did a weekly check-in in the last 7 days.",
        },
        retention: {
          d30Pct: pct(Number(r.retained_30d || 0), Number(r.eligible_30d || 0)),
          d90Pct: pct(Number(r.retained_90d || 0), Number(r.eligible_90d || 0)),
          d180Pct: pct(Number(r.retained_180d || 0), Number(r.eligible_180d || 0)),
          cohorts: { eligible30d: Number(r.eligible_30d || 0), eligible90d: Number(r.eligible_90d || 0), eligible180d: Number(r.eligible_180d || 0) },
          note: "Retained = joined ≥N days ago AND active within the last 14 days. Reviewer targets: >70% @30d, >50% @60d, >30% @90d.",
        },
        escalation: {
          escalations30d: Number(e.escalations_30d || 0),
          clientsEscalated30d: Number(e.clients_escalated_30d || 0),
          ratePct: pct(Number(e.clients_escalated_30d || 0), active),
          note: "Share of active clients who needed a human in 30 days. Reviewer target: <2%.",
        },
      });
    } catch (err) {
      console.error("[OUTCOMES]", err);
      res.status(500).json({ message: "Failed to compute outcome metrics" });
    }
  });
}
