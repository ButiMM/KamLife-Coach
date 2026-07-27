/**
 * MONTHLY RAND CEILING — the business-level backstop on AI spend.
 *
 * (2026-07-27.) The per-member daily caps in usage-governor.ts protect against ONE runaway
 * member. They do nothing about the total: 200 members each using a perfectly normal amount is
 * still a bill nobody capped. At a flat R199/member the business dies quietly if AI cost per
 * member drifts past the margin, and the founder would find out from a bank statement.
 *
 * Past the ceiling the expensive operations degrade — voice falls back to text, vision asks
 * them to type the meal — while every deterministic thing (logging, targets, programmes, cards)
 * keeps working exactly as before. The product gets cheaper, never broken.
 *
 * Set AI_MONTHLY_CEILING_ZAR in Railway. Unset = no ceiling (current behaviour).
 * Pure — kept free of the DB so it stays unit-testable.
 */

export type CeilingState = "ok" | "warn" | "over";

/** Rand per US dollar. Override with USD_ZAR when the rate moves materially. */
export function usdToZarRate(): number {
  const n = parseFloat(process.env.USD_ZAR || "");
  return Number.isFinite(n) && n > 0 ? n : 18.5;
}

/** The configured ceiling in rand, or null when none is set. */
export function monthlyCeilingZar(): number | null {
  const n = parseFloat(process.env.AI_MONTHLY_CEILING_ZAR || "");
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The decision, given spend so far and the ceiling. Warns at 80% so there's time to react. */
export function ceilingState(spentZar: number, ceilingZar: number | null): CeilingState {
  if (!ceilingZar) return "ok";
  if (spentZar >= ceilingZar) return "over";
  if (spentZar >= ceilingZar * 0.8) return "warn";
  return "ok";
}
