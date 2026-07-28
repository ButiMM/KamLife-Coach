/**
 * JOB HEALTH — is the core loop actually running, and is it still finishing in time?
 *
 * (2026-07-28, from the engineering review: "the scheduler records how long each job took and
 * nothing reads it. At 50 clients the 6am fan-out finishes in seconds. At 5,000 it may not
 * finish before the 7pm one starts, and the first sign will be a client saying they stopped
 * getting messages.")
 *
 * Two failures matter and neither shows up in a log you have to go looking for:
 *   OVERDUE — a job that should have run by now hasn't. Silent, and it never recovers on its own.
 *   SLOW    — a job still finishing, but taking long enough that growth will push it past its
 *             window. This is the one you want to see months before it breaks.
 *
 * The expected cadence is derived from the cron expression itself rather than a second table
 * that would drift out of step with the schedule. Pure — no DB, no clock of its own. Unit-tested.
 */

export interface JobSnapshot {
  name: string;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastOk: boolean | null;
  runs: number;
  failures: number;
  /** The cron expression it was registered with, when known. */
  cron?: string;
}

export type JobVerdict = "ok" | "slow" | "failing" | "overdue" | "never_ran";

export interface JobFinding {
  name: string;
  verdict: JobVerdict;
  detail: string;
}

/**
 * Hours between runs, from a 5-field cron expression. Only needs to be right to an order of
 * magnitude — it exists to answer "should this have run by now", not to schedule anything.
 */
export function expectedGapHours(expr?: string): number {
  const f = (expr || "").trim().split(/\s+/);
  if (f.length < 5) return 24;
  const [min, hour, , , dow] = f;
  if (min.startsWith("*/")) return Math.max(1, Number(min.slice(2)) || 1) / 60;
  if (min === "*") return 1 / 60;
  if (hour === "*") return 1;
  if (hour.startsWith("*/")) return Math.max(1, Number(hour.slice(2)) || 1);
  // A list of hours ("4,16") runs that many times a day.
  const hours = hour.split(",").filter(Boolean).length;
  const perDay = hours > 1 ? 24 / hours : 24;
  // A weekday restriction stretches the gap — a Monday-only job may idle six days.
  if (dow && dow !== "*") {
    const days = dow.split(",").filter(Boolean).length;
    return perDay * (days > 0 ? 7 / days : 7);
  }
  return perDay;
}

/**
 * How long a run may take before it is worth knowing about. A minute-ly job that takes 30
 * seconds is already in trouble; a weekly report that takes 30 seconds is fine. So the budget
 * is a fraction of the gap, floored so a fast job is never flagged for normal variance.
 */
export function durationBudgetMs(gapHours: number): number {
  return Math.max(30_000, gapHours * 3_600_000 * 0.25);
}

/** Grace before "should have run" becomes "has not run" — one full extra cycle, plus a bit. */
export function overdueAfterMs(gapHours: number): number {
  return gapHours * 3_600_000 * 2 + 5 * 60_000;
}

/**
 * Read the registry. `now` is passed in so this stays pure and testable. A job that has never
 * run is only reported once the process has been up long enough for it to have had a turn —
 * otherwise every restart would report the entire weekly schedule as broken.
 */
export function assessJobs(jobs: JobSnapshot[], now: number, uptimeMs = Infinity): JobFinding[] {
  const out: JobFinding[] = [];
  for (const j of jobs) {
    const gap = expectedGapHours(j.cron);
    if (!j.lastRunAt) {
      if (uptimeMs > overdueAfterMs(gap)) {
        out.push({ name: j.name, verdict: "never_ran", detail: `no run in ${Math.round(uptimeMs / 3_600_000)}h up — expected every ${fmtGap(gap)}` });
      }
      continue;
    }
    const since = now - new Date(j.lastRunAt).getTime();
    if (since > overdueAfterMs(gap)) {
      out.push({ name: j.name, verdict: "overdue", detail: `last ran ${Math.round(since / 3_600_000)}h ago — expected every ${fmtGap(gap)}` });
      continue;
    }
    if (j.lastOk === false) {
      out.push({ name: j.name, verdict: "failing", detail: `last run failed (${j.failures} of ${j.runs})` });
      continue;
    }
    const budget = durationBudgetMs(gap);
    if ((j.lastDurationMs || 0) > budget) {
      out.push({ name: j.name, verdict: "slow", detail: `took ${Math.round((j.lastDurationMs || 0) / 1000)}s against a ${Math.round(budget / 1000)}s budget` });
    }
  }
  const rank: Record<JobVerdict, number> = { never_ran: 0, overdue: 1, failing: 2, slow: 3, ok: 4 };
  return out.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
}

function fmtGap(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}min`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

const LABEL: Record<JobVerdict, string> = {
  never_ran: "never ran", overdue: "overdue", failing: "failing", slow: "slow", ok: "ok",
};

/** One block for the founder-facing report. Silence is the good news. */
export function jobHealthLines(findings: JobFinding[], total: number): string {
  if (total === 0) return "⏱ *Scheduler:* no jobs registered yet.";
  if (findings.length === 0) return `⏱ *Scheduler:* all ${total} jobs on time and inside budget.`;
  const lines = findings.slice(0, 6).map(f => `• *${f.name}* — ${LABEL[f.verdict]}: ${f.detail}`);
  const more = findings.length > 6 ? `\n_…and ${findings.length - 6} more._` : "";
  return `⏱ *Scheduler:* ${findings.length} of ${total} jobs need attention.\n\n${lines.join("\n")}${more}`;
}
