# The three numbers — how to actually measure them

Written 2026-08-06, when the build stopped and the beta started. Every column name here was
checked against `shared/schema.ts`, so these run as-is against the production database.

Nothing in this document is a feature. It is the instrument for the only question that matters
now: **is this a business or a very good demo?**

---

## 1. Food accuracy — the highest-stakes number, never measured

**Why it decides everything.** Every target, every "you have 400 kcal left", every deficit
depends on the estimate being roughly right. If it runs 25% light, a client eating to their
number is in a much smaller deficit than they think. The scale doesn't move. They don't blame
the bot — **they blame themselves, and they quit.** That failure is invisible from inside the
system, because nothing in the logs looks wrong.

**Not a query — a kitchen scale.** No amount of code can check this.

### Method

Twenty meals, over a normal week, spread across how people really log:

- 7 typed ("pap and chicken", "2 slices toast and eggs")
- 7 photographed
- 6 by voice note

For each one, before eating: weigh each component in grams and write it down. Then log it the
normal way and record what the bot said.

| # | How logged | What it was (weighed) | True kcal | Bot kcal | Diff % |
|---|---|---|---|---|---|

True kcal from the packet where there is one, or a reference table for raw ingredients.

### Reading the result

- **Within ±10% on average** — fine. Estimation error is smaller than day-to-day variation in
  what people actually eat.
- **Systematically light by 15%+** — this is the quiet killer. Fix before scaling.
- **Wild scatter (some +40%, some −40%)** — worse than a consistent bias, because no
  correction factor helps. Look at which of the three input methods is scattering.

Split the average by method. If photos are fine and voice is 30% out, that is an STT problem,
not an estimation problem — and the vocabulary bias shipped on 2026-08-06 is the first thing
to re-check.

---

## 2. Margin — before you scale, not after

Costs are already tracked in `gpt_costs` (every model call, tagged by `feature`). Nobody has
read the table. Vision on food photos is the expensive path, and a keen client sends six a day.

### Cost per client, last 30 days

```sql
SELECT
  u.name,
  u.phone_number,
  ROUND(SUM(g.cost_usd), 4)                        AS usd_30d,
  ROUND(SUM(g.cost_usd) * 18.5, 2)                 AS rand_30d,   -- adjust the rate
  ROUND(SUM(g.cost_usd) * 18.5 / 199 * 100, 1)     AS pct_of_r199,
  COUNT(*)                                          AS calls
FROM gpt_costs g
JOIN users u ON u.id = g.user_id
WHERE g.created_at > NOW() - INTERVAL '30 days'
GROUP BY u.id, u.name, u.phone_number
ORDER BY usd_30d DESC;
```

**The number to watch is `pct_of_r199` for the HEAVIEST user, not the average.** The average
tells you nothing about whether one enthusiastic client can cost you money.

### Where the money actually goes

```sql
SELECT
  g.feature,
  g.model,
  COUNT(*)                          AS calls,
  ROUND(SUM(g.cost_usd), 4)         AS usd,
  ROUND(AVG(g.cost_usd), 6)         AS usd_per_call
FROM gpt_costs g
WHERE g.created_at > NOW() - INTERVAL '30 days'
GROUP BY g.feature, g.model
ORDER BY usd DESC;
```

If `food_vision` on `gpt-4o` dominates, the lever is the daily photo cap — which already
exists — not a cheaper coach.

### Reading the result

- **Under 15% of R199 for the heaviest client** — healthy, scale freely.
- **15–35%** — fine, but the photo cap matters and should not be raised.
- **Over 50% for anyone** — one client is eating the margin. Find out what they are doing
  before you have a hundred of them.

---

## 3. Week-4 retention — if they leave, nothing else matters

The code calls week 3 "the danger zone" in `pattern` context. Somebody already knew.

### Are they still logging?

```sql
WITH cohort AS (
  SELECT id, name, created_at,
         DATE_PART('day', NOW() - created_at) AS days_since_signup
  FROM users
  WHERE onboarding_state = 'COMPLETE'
    AND created_at < NOW() - INTERVAL '28 days'
)
SELECT
  c.name,
  ROUND(c.days_since_signup)                                   AS days_in,
  COUNT(DISTINCT DATE(m.logged_at))                            AS days_logged_total,
  COUNT(DISTINCT DATE(m.logged_at)) FILTER (
    WHERE m.logged_at > c.created_at + INTERVAL '21 days'
      AND m.logged_at < c.created_at + INTERVAL '28 days')     AS days_logged_week4
FROM cohort c
LEFT JOIN meal_logs m ON m.user_id = c.id
GROUP BY c.id, c.name, c.days_since_signup, c.created_at
ORDER BY days_logged_week4 DESC;
```

**`days_logged_week4` is the whole number.** 3 or more out of 7 is a client who is still in it.
Zero is a client who has gone, whatever their subscription says.

### Where they went quiet

```sql
SELECT
  u.name,
  MAX(ch.created_at)                                       AS last_message,
  ROUND(DATE_PART('day', NOW() - MAX(ch.created_at)))      AS days_silent,
  ROUND(DATE_PART('day', MAX(ch.created_at) - u.created_at)) AS lasted_days
FROM users u
JOIN chat_history ch ON ch.user_id = u.id
WHERE u.onboarding_state = 'COMPLETE'
GROUP BY u.id, u.name, u.created_at
ORDER BY days_silent DESC;
```

`lasted_days` clustering around the same number is the drop-off cliff. That is the week to
intervene in, and it is worth more than any new feature.

---

## 4. The usage query — for cutting on evidence, not taste

Do not run this until the 10 have been live for a month. With four users it cannot tell
"nobody wants it" from "nobody has had the chance".

```sql
SELECT
  intent,
  COUNT(*)                  AS uses,
  COUNT(DISTINCT user_id)   AS clients
FROM chat_history
WHERE created_at > NOW() - INTERVAL '60 days'
GROUP BY intent
ORDER BY uses DESC;
```

**Fewer than ~3 distinct clients in 60 days = a feature being paid for that nobody uses.**
Cut on that, not on instinct — including mine.

---

## 5. What to watch that no query will tell you

- **Do they ever open a workout?** The codebase is built around a training spine, but this
  market mostly wants food and steps. If eight of the ten never send *workout*, that is the
  next simplification and it is a big one.
- **Shared pots.** "I ate what my mother cooked" is the daily case in a South African
  household and it is genuinely hard to estimate. Watch how often it comes up and how badly
  the estimate lands.
- **Prepaid airtime.** Photos cost data. If someone stops sending photos in the last week of
  the month, that is not disengagement — that is money, and text-first has to stay excellent.
- **No scale at home.** Many will not own one. Weight-less progress — clothes, energy, photos
  — matters more here than in any Western app.

---

## The bar

Ship to the 10. Measure these three. Everything else — every feature, every cut, every
rewrite — waits for what those numbers say.
