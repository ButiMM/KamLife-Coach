// ============================================================
// SINGLE SOURCE OF TRUTH — PRICING & PLAN CONFIGURATION
// ============================================================
// Every price, tier, and revenue formula in the entire codebase
// should import from this file. Never hardcode R149 or any price
// in routes, scheduler, dashboard, or frontend.
// ============================================================

export const PRICING = {
  /**
   * Monthly subscription price in ZAR. THIS IS THE BILLING AMOUNT, not a label:
   * routes/payments.ts sends it to PayFast as both `amount` and `recurring_amount`, and
   * verifies the ITN against it. Changing it changes what a customer is charged.
   */
  monthlyPriceZAR: 149,

  /** Display string for UI/messages */
  monthlyDisplay: "R149/month",

  /** Daily equivalent (for marketing) — 149 / 30, rounded to the cent. */
  dailyDisplay: "R4.97/day",

  /** Currency code */
  currency: "ZAR",

  /**
   * THE RISK REVERSAL, and it had no owner until now (2026-09-02).
   *
   * "7-day money-back" was hardcoded in five customer-facing places — onboarding's paywall,
   * two referral messages, the first-session share prompt, and painted onto the join QR
   * image — so the promise could drift per surface and did. The offer is 14 days; there is
   * one number to change.
   */
  guaranteeDays: 14,
} as const;

/** "14-day money-back guarantee" — written once so five surfaces cannot disagree. */
export const GUARANTEE_PHRASE = `${PRICING.guaranteeDays}-day money-back guarantee`;

// TRIAL LENGTH IS NOT DECLARED HERE, deliberately (2026-09-02). This file used to carry
// `trialDays: 7` while server/pricing-config.ts — the module every trial consumer actually
// imports — defaulted TRIAL_DAYS to 0. Two owners of one fact, disagreeing, in the file that
// calls itself the single source of truth. It had zero readers, so it was not a runtime bug;
// it was a false statement about the product sitting where people go to check. The owner is
// pricing-config.ts, which also holds the grandfathering rule. Do not add it back here.

// ============================================================
// METRIC FORMULAS — used by all dashboard/reporting endpoints
// ============================================================

/** Monthly Recurring Revenue = paying subscribers × monthly price */
export function calculateMRR(payingUsers: number): number {
  return payingUsers * PRICING.monthlyPriceZAR;
}

/** Average Revenue Per User (paying only) */
export function calculateARPU(payingUsers: number): number {
  if (payingUsers <= 0) return 0;
  return PRICING.monthlyPriceZAR; // single tier for now
}

/** Estimated LTV based on churn rate */
export function calculateLTV(monthlyChurnRate: number): number {
  if (monthlyChurnRate <= 0 || monthlyChurnRate >= 1) return PRICING.monthlyPriceZAR * 12; // cap at 12 months
  return PRICING.monthlyPriceZAR / monthlyChurnRate;
}

/** Trial-to-paid conversion rate */
export function calculateTrialConversion(trialUsers: number, paidUsers: number): number {
  if (trialUsers + paidUsers <= 0) return 0;
  return Math.round((paidUsers / (trialUsers + paidUsers)) * 100);
}

/** Monthly churn rate */
export function calculateChurnRate(startOfMonthPaying: number, endOfMonthPaying: number, newPaying: number): number {
  if (startOfMonthPaying <= 0) return 0;
  const churned = startOfMonthPaying + newPaying - endOfMonthPaying;
  return Math.max(0, churned / startOfMonthPaying);
}
