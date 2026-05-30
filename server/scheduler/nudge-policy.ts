/**
 * Nudge cadence policy — PURE functions only.
 *
 * No DB, no Twilio, no side effects. Lives apart from scheduler/shared.ts (which
 * touches the DB on import) so it can be unit-tested without a database and reused
 * anywhere without dragging in heavy deps.
 */

// Engagement back-off for ROUTINE nudges (hydration, evening accountability).
// Routine nudges ease off as a client goes quiet — protects against WhatsApp
// mutes and cuts message cost at scale.
//
// NOTE: win-back / retention jobs deliberately target silent users and must NOT
// use this — they own the 3+ day silent clients with tailored comeback messaging.
//
// Cadence:
//   daysSilent 0–1 (engaged)    → every run
//   daysSilent 2   (drifting)   → every other day (halves volume)
//   daysSilent 3+  (gone quiet) → stop; retention/win-back owns this client
export function routineNudgeAllowed(daysSilent: number, dayOfYear: number): boolean {
  if (daysSilent <= 1) return true;
  if (daysSilent === 2) return dayOfYear % 2 === 0;
  return false;
}

export function dayOfYearSAST(): number {
  const sast = new Date(Date.now() + 2 * 3_600_000);
  const yearStart = Date.UTC(sast.getUTCFullYear(), 0, 1);
  return Math.floor((sast.getTime() - yearStart) / 86_400_000);
}
