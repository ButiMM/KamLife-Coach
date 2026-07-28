/**
 * ENGAGEMENT — where clients go quiet, and what the coach said just before they did.
 *
 * (2026-07-28, ledger D5.) The reply auditor answers "is the coach saying wrong things". This
 * answers the question that decides whether the business works: "are people still here, and if
 * not, when did we lose them?" Nothing measured it. At R199/month a client who quietly stops
 * logging in week two is the whole P&L, and nobody would have known until the churn showed up.
 *
 * Three things, in order of how useful they are:
 *
 *   1. WHO IS SLIPPING RIGHT NOW — actionable today. Sorted by risk, not alphabetically.
 *   2. THE DROP-OFF CURVE — what share are still logging at day 3, 7, 14, 30. This is the
 *      retention shape of the product, and it is the number an investor asks for.
 *   3. WHAT PRECEDED THE SILENCE — for every client who went quiet, the LAST thing the coach
 *      said to them, grouped. If one kind of reply keeps appearing right before people vanish,
 *      that is the most valuable sentence in this whole codebase.
 *
 * (3) is the reason this exists. Retention dashboards tell you people left; this points at the
 * message they left after.
 *
 * Pure — no DB, no clock beyond an injected `now`. Unit-tested.
 */

export interface ActivityRow {
  userId: string;
  name: string | null;
  createdAt: Date;
  /** Last time the CLIENT spoke. Bot messages don't count as engagement. */
  lastInboundAt: Date | null;
  /** Day-of-journey indices (0 = signup day) on which they logged anything. */
  activeDays: number[];
  /** Intent of the last thing the coach said to them. */
  lastCoachIntent: string | null;
}

export type RiskBand = "active" | "slipping" | "quiet" | "gone";

export interface ClientRisk {
  userId: string;
  name: string;
  daysSinceActive: number;
  journeyDay: number;
  band: RiskBand;
  lastCoachIntent: string | null;
}

const DAY = 86_400_000;

/** Whole days between two instants, floored, never negative. */
function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - new Date(a).getTime()) / DAY));
}

/**
 * Risk band from silence length. Chosen against how this product is used: it asks for something
 * daily, so 3 days of nothing is already a signal and 14 is effectively gone.
 */
export function bandFor(daysSinceActive: number): RiskBand {
  if (daysSinceActive >= 14) return "gone";
  if (daysSinceActive >= 7) return "quiet";
  if (daysSinceActive >= 3) return "slipping";
  return "active";
}

/** Per-client risk, worst first. A client who never spoke at all counts from signup. */
export function assessClients(rows: ActivityRow[], now: Date): ClientRisk[] {
  return rows
    .map(r => {
      const since = r.lastInboundAt ? daysBetween(r.lastInboundAt, now) : daysBetween(r.createdAt, now);
      return {
        userId: r.userId,
        name: (r.name || "").split(" ")[0] || "(no name)",
        daysSinceActive: since,
        journeyDay: daysBetween(r.createdAt, now),
        band: bandFor(since),
        lastCoachIntent: r.lastCoachIntent,
      };
    })
    .sort((a, b) => b.daysSinceActive - a.daysSinceActive);
}

export interface CurvePoint { day: number; stillActive: number; of: number; pct: number }

/**
 * THE DROP-OFF CURVE. For each milestone day, of the clients who have BEEN with us that long,
 * what share were still logging on or after that day.
 *
 * The "of" denominator matters and is the thing most dashboards get wrong: a client who signed
 * up yesterday cannot tell you anything about day-30 retention, so they are excluded from that
 * point rather than counted as churned.
 */
export function dropOffCurve(rows: ActivityRow[], now: Date, milestones = [1, 3, 7, 14, 30]): CurvePoint[] {
  return milestones.map(day => {
    const eligible = rows.filter(r => daysBetween(r.createdAt, now) >= day);
    const stillActive = eligible.filter(r => r.activeDays.some(d => d >= day)).length;
    return {
      day,
      stillActive,
      of: eligible.length,
      pct: eligible.length ? Math.round((stillActive / eligible.length) * 100) : 0,
    };
  });
}

export interface SilenceTrigger { intent: string; count: number; share: number }

/**
 * WHAT THE COACH SAID LAST, for clients who then went quiet. Grouped by intent and ranked.
 *
 * This is correlation, not proof — some intents are simply common. It is still the fastest way
 * to find a reply that is quietly costing clients, and it turns "why do people leave?" from a
 * guess into a short list worth reading.
 */
export function silenceTriggers(risks: ClientRisk[]): SilenceTrigger[] {
  const quiet = risks.filter(r => r.band === "quiet" || r.band === "gone");
  const counts = new Map<string, number>();
  for (const r of quiet) {
    const key = r.lastCoachIntent || "(unknown)";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = quiet.length || 1;
  return [...counts.entries()]
    .map(([intent, count]) => ({ intent, count, share: Math.round((count / total) * 100) }))
    .sort((a, b) => b.count - a.count);
}

export interface EngagementSummary {
  total: number;
  byBand: Record<RiskBand, number>;
  curve: CurvePoint[];
  triggers: SilenceTrigger[];
  atRisk: ClientRisk[];
}

/** Everything in one pass. `atRisk` is capped — a list nobody reads helps nobody. */
export function summariseEngagement(rows: ActivityRow[], now: Date, atRiskLimit = 10): EngagementSummary {
  const risks = assessClients(rows, now);
  const byBand: Record<RiskBand, number> = { active: 0, slipping: 0, quiet: 0, gone: 0 };
  for (const r of risks) byBand[r.band]++;
  return {
    total: risks.length,
    byBand,
    curve: dropOffCurve(rows, now),
    triggers: silenceTriggers(risks),
    atRisk: risks.filter(r => r.band === "slipping" || r.band === "quiet").slice(0, atRiskLimit),
  };
}
