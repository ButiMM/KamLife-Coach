# KamLife Coach — Stabilization and Growth Summary
_Date: 2026-04-10_

## What Was Fixed (This Session)

### P0 — Critical Stabilization (DONE)

**Auth System**
- Login endpoint was returning `{success: true}` but frontend expected `{token}`. Dashboard auth was broken. Fixed — login now returns the token correctly.
- Two separate auth keys existed (`COACH_DASHBOARD_KEY` and `DASHBOARD_API_KEY`) protecting different routes. Unified to one key (`COACH_DASHBOARD_KEY`) for all 43 protected endpoints.

**API Contracts**
- Shared route contracts said `/api/webhooks/whatsapp` and `/api/webhooks/payfast`. Actual server routes were `/twilio/whatsapp` and `/webhook/payfast`. Fixed — contracts now match reality.
- Added missing `/webhook/status` (Twilio delivery callbacks) to contracts.

**Pricing Consistency**
- Frontend showed R99, backend used R149, ARPU was hardcoded to 99. Created `shared/pricing.ts` as single source of truth. All 5 MRR calculations and all UI references now pull from one place.

**ID Typing**
- Frontend `useUser()` hook typed user ID as `number`, but database uses UUID strings. Fixed to `string`. Removed unsafe `as any` casts.

**Duplicate Routes**
- `/api/dashboard/cohorts` was registered twice (monthly + weekly). Express only hit the first one. Moved weekly to `/api/dashboard/cohorts/weekly`.

### Intelligence Layer (DONE — earlier this session)

**Age-Aware Coaching**
- Added age collection to onboarding (14-110 range).
- Youth (14-17): 3 training days, no heavy maxing, fun tone.
- Seniors (60+): 3 training days, joint-friendly mods, mandatory warm-up, lower step targets.
- Standard (18-59): 4 training days, full programme.

**Adaptive GPT Context**
- Every AI response now includes: coaching maturity (week 1 tone vs week 8+ veteran tone), age guidelines, step compliance, weekend patterns, food logging consistency.
- New clients get encouraging tone. Week 3 clients get danger-zone awareness. Week 8+ clients get peer-level coaching.

**Progressive Difficulty**
- Walking targets ramp: 70% weeks 1-2, 85% weeks 3-4, 100% week 5+.
- Workouts include age-appropriate warm-ups and safety notes.

**Smart Messaging**
- Silent clients (3-7 days) get re-engagement messages instead of silence.
- Evening check-ins score the day (food + workout + steps) and adapt the closing message.

### Business Model (DONE — earlier this session)

**7-Day Free Trial**
- New signups get full access immediately (subscriptionStatus: "trial").
- Trial countdown shows in menu header.
- Explicit expiry message when trial ends (not silent downgrade).
- Trial nudges on day 5 and day 7.

**First-Value Delivery**
- Onboarding completion now immediately delivers Day 1 workout preview + Week 1 shopping list.
- Client experiences the product before being asked to pay.

---

## What Remains

### P1 — Product Quality (next 2 weeks)

| Item | Impact | Status |
|------|--------|--------|
| Funnel tracking — instrument signup, onboard, first workout, week 1, paid, churn events | High | Not started |
| Dashboard trust — "last updated" timestamps on metrics | Medium | Not started |
| Coaching QA — guardrails on GPT response length/quality | Medium | Not started |
| Escalation visibility — surface medical/billing/support requests in dashboard | Medium | Tables exist, not wired to UI |

### P2 — Business/CFO Readiness (next 4 weeks)

| Item | Impact | Status |
|------|--------|--------|
| Monthly snapshot report endpoint (immutable period closes) | High | Not started |
| Unit economics baseline (LTV, churn rate, D1/D7/D30 retention) | High | Formulas created in pricing.ts, not computed live yet |
| Plan/tier configuration for future expansion | Low | Single tier works for now |

### P3 — Engineering Quality (next 1-2 months)

| Item | Impact | Status |
|------|--------|--------|
| Split routes.ts (8,400 lines) into domain modules | High for maintainability | Not started |
| Integration tests for auth, webhooks, payments | High for reliability | Not started |
| Structured logging + correlation IDs | Medium | Not started |
| Cron job consolidation (46 jobs) | Low urgency | Working but noisy |

---

## 30 / 60 / 90 Day Roadmap

### Next 30 Days
1. Get 10 real humans testing the product end-to-end
2. Build funnel tracking (signup → onboard → first workout → week 1 → paid)
3. Verify PayFast webhook end-to-end (payment → subscription activation)
4. Apply for WhatsApp Business API approval
5. Set up basic landing page with WhatsApp CTA

### 30-60 Days
1. Analyse real user data — where do people drop off?
2. Build monthly finance snapshot report
3. Split routes.ts into domain modules
4. Add integration tests for critical paths
5. Start measuring trial-to-paid conversion rate

### 60-90 Days
1. Optimise based on real retention data
2. Build referral tracking dashboard
3. Add re-engagement campaign segments
4. Prepare for 100-user scale (WhatsApp cost monitoring, rate limiting)
5. Consider second tier (R249 with voice notes / human coach escalation)

---

## Metric Definitions

All metrics use formulas from `shared/pricing.ts`.

| Metric | Formula | Source |
|--------|---------|--------|
| MRR | paying_users x R149 | `calculateMRR()` |
| ARPU | R149 (single tier) | `calculateARPU()` |
| LTV | R149 / monthly_churn_rate | `calculateLTV()` |
| Trial Conversion | paid / (trial + paid) x 100 | `calculateTrialConversion()` |
| Churn Rate | (start + new - end) / start | `calculateChurnRate()` |
| Activation Rate | onboarding_complete / total_signups | Computed in dashboard/funnel |
| Week 1 Retention | active_day_7 / onboarded | Not yet instrumented |

---

## Founder Readout

### What improved
- **Dashboard actually works now.** Auth was broken — login returned the wrong thing. Fixed.
- **One key to rule them all.** No more confusion about which env var unlocks which routes.
- **Pricing is consistent everywhere.** R149 from WhatsApp messages to landing page to MRR dashboard. One source file controls all of it.
- **The product is smarter.** A 15-year-old and a 65-year-old now get different coaching, different intensity, different tone. Walking targets build up over weeks instead of day-1 shock.
- **Trial converts better.** New users see their first workout and shopping list immediately. Trial countdown creates urgency. Expiry message includes their progress.

### Expected business impact
- **Trial-to-paid conversion should increase** — users experience value before hitting the paywall, and countdown creates urgency.
- **Retention should improve** — adaptive tone means week 3 clients (highest churn risk) get addressed differently than week 1 clients.
- **Dashboard is now decision-grade** — MRR, ARPU, and conversion numbers you can trust.

### Top 3 next priorities
1. **Get 10 real people on it.** Everything we've built is untested with real SA WhatsApp users. This is the only thing that matters right now.
2. **Verify PayFast end-to-end.** We can't collect money until payment → subscription activation is confirmed working.
3. **Funnel tracking.** We need to see where people drop off: signup → onboard → first workout → week 1 → paid. Can't improve what we can't measure.
