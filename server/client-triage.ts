/**
 * Client triage — turns the flat user list into an intervention-first "who needs help
 * today" queue for the coach dashboard (competitive audit 3.6 / Trainerize+Future pattern).
 *
 * Lean and SAFE: a PURE classifier + one read-only endpoint (see routes/admin.ts).
 * It never touches the WhatsApp message pipeline, so it cannot affect a client's
 * experience — it only changes what the operator sees.
 *
 * Precedence (highest risk wins): safety escalation > churn > long silence >
 * short silence > training accountability > on track.
 */

export type RiskLevel = "red" | "yellow" | "green";

export interface ClientTriageInput {
  /** Days since the client's last inbound message; null = never messaged. */
  daysSinceActive: number | null;
  /** Days since account creation — used so a brand-new signup isn't flagged "silent". */
  daysSinceSignup: number;
  /** Open escalation of urgent/high priority (safety/injury/crisis). */
  hasOpenUrgentEscalation: boolean;
  /** active | trial | inactive | cancelled */
  subscriptionStatus: string;
  /** trainingDaysPerWeek (planned). */
  plannedSessionsPerWeek: number;
  /** Workouts logged in the last 7 days. */
  workoutsLast7: number;
}

export interface ClientTriage {
  level: RiskLevel;
  reason: string;     // the single most important reason
  nextAction: string; // concrete next step for the coach
}

const RANK: Record<RiskLevel, number> = { red: 0, yellow: 1, green: 2 };

export function computeClientRisk(inp: ClientTriageInput): ClientTriage {
  // 1. Safety always wins — an open urgent/high escalation is the top of the queue.
  if (inp.hasOpenUrgentEscalation) {
    return { level: "red", reason: "Open safety escalation", nextAction: "Respond to the escalation now" };
  }

  // 2. Churn — explicitly cancelled. Win-back, not coaching.
  if (inp.subscriptionStatus === "cancelled") {
    return { level: "red", reason: "Subscription cancelled", nextAction: "Send a win-back message" };
  }

  // A brand-new signup (<2 days) with no activity yet is onboarding, not "silent".
  const isFresh = inp.daysSinceSignup < 2;

  // 3. Long silence — 5+ days quiet is a churn risk.
  if (inp.daysSinceActive === null) {
    if (!isFresh) {
      return { level: "red", reason: "Never engaged since signup", nextAction: "Personal onboarding nudge" };
    }
    return { level: "green", reason: "New signup — onboarding", nextAction: "None — let onboarding run" };
  }
  if (inp.daysSinceActive >= 5) {
    return { level: "red", reason: `Silent ${inp.daysSinceActive} days`, nextAction: "Win-back check-in today" };
  }

  // 4. Short silence — 2–4 days quiet warrants a light nudge.
  if (inp.daysSinceActive >= 2) {
    return { level: "yellow", reason: `Quiet ${inp.daysSinceActive} days`, nextAction: "Light check-in" };
  }

  // 5. Training accountability — active and talking, but missing sessions.
  const minSessions = Math.ceil(inp.plannedSessionsPerWeek / 2);
  if (inp.plannedSessionsPerWeek > 0 && inp.workoutsLast7 < minSessions) {
    return {
      level: "yellow",
      reason: `Only ${inp.workoutsLast7}/${inp.plannedSessionsPerWeek} sessions this week`,
      nextAction: "Nudge today's workout",
    };
  }

  // 6. On track.
  return { level: "green", reason: "Active and on track", nextAction: "None" };
}

/** Sort a triaged list red → yellow → green, then most-silent first within a level. */
export function sortByRisk<T extends { triage: ClientTriage; daysSinceActive: number | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const r = RANK[a.triage.level] - RANK[b.triage.level];
    if (r !== 0) return r;
    // within the same level, the longest-silent client is the most urgent
    const da = a.daysSinceActive ?? Number.POSITIVE_INFINITY;
    const dbb = b.daysSinceActive ?? Number.POSITIVE_INFINITY;
    return dbb - da;
  });
}
