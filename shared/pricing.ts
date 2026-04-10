// ============================================================
// SINGLE SOURCE OF TRUTH — PRICING & PLAN CONFIGURATION
// ============================================================
// Every price, tier, and revenue formula in the entire codebase
// should import from this file. Never hardcode R149 or any price
// in routes, scheduler, dashboard, or frontend.
// ============================================================

export const PRICING = {
  /** Monthly subscription price in ZAR */
  monthlyPriceZAR: 149,

  /** Display string for UI/messages */
  monthlyDisplay: "R149/month",

  /** Daily equivalent (for marketing) */
  dailyDisplay: "R5/day",

  /** Currency code */
  currency: "ZAR",

  /** Free trial duration in days */
  trialDays: 7,
} as const;

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
