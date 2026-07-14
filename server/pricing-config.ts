// Monetization config (2026-07-14, founder directive: "I hate trials — people churn
// by the 7th/14th day"). PAY-TO-START by default: no free-access window. A new member
// gets the full onboarding conversation + their personalised Day-1 programme as the
// taste, then pays to continue — backed by a money-back guarantee (risk reversal
// WITHOUT giving the product away for a week and filtering for committed members).
//
// TRIAL_DAYS>0 reinstates a free trial of that many days — one env change, instantly
// reversible if the funnel needs it. Existing trial members are grandfathered (the
// gate respects their betaBypassUntil); only NEW signups are affected.
export const TRIAL_DAYS = Math.max(0, Math.floor(Number(process.env.TRIAL_DAYS ?? 0)));
export const TRIALS_ENABLED = TRIAL_DAYS > 0;
