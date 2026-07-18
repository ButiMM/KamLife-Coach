/**
 * MORNING BRIEF CLOSING LINE — pure, dependency-free, unit-tested (extracted from
 * scheduler/jobs/morning.ts so it can be tested without the scheduler's cron chain).
 *
 * The absence-framed lines ("Good to have you back", "just reply Hi and we go from
 * there") assume the client lapsed and returned. They must NEVER fire for someone
 * actively engaged (a live food streak) — a daily logger never left, and telling them
 * "welcome back" over a 19-day streak is the 2026-07-19 live incident. The engaged
 * closings also make no "session today" push, so they stay honest on a rest day.
 */

export type MorningTrajectory = "ON_A_RUN" | "ON_TRACK" | "RECOVERING" | "STRUGGLING" | "DISENGAGED";

export function morningClosingLine(
  trajectory: MorningTrajectory,
  ctx: { activelyEngaged: boolean; completedSessions28: number },
): string {
  const { activelyEngaged, completedSessions28 } = ctx;
  switch (trajectory) {
    case "ON_A_RUN":
      return `\n\n_You're ${completedSessions28} sessions in over 4 weeks. Don't give this up — most people are nowhere near this._`;
    case "ON_TRACK":
      return ``;
    case "RECOVERING":
      return activelyEngaged
        ? `\n\n_You're logging every day — that consistency is exactly what changes bodies. Keep the chain going._`
        : `\n\n_Good to have you back. One day at a time — this week counts._`;
    case "STRUGGLING":
      return `\n\n_${completedSessions28} sessions in 4 weeks — let's get one in today. Just one. Reply 1 and I'll send it._`;
    case "DISENGAGED":
      return activelyEngaged
        ? `\n\n_Logging your food every single day — that's the hard habit, and it's yours. When you're ready to train, reply 1._`
        : `\n\n_No sessions in 28 days. Today is not about intensity — just reply Hi and we go from there._`;
  }
}
