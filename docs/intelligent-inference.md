# Intelligent inference — "infer, don't interrogate"

> **Status: EXECUTED — 17 July 2026.** The design conversation happened and the
> verification-first pass found MOST of the agenda already built (see below).
> The one real gap — night-shift meal slotting — was closed the same day.
>
> Verified as already built (with file pointers):
> - Meal-slot inference: keyword extraction + light-bite snack heuristic +
>   total time-of-day fallback (`food-context.extractMealLabel`, `utils.slotFromSastHour`).
> - Portion defaults: `typicalPortion*` per food + `portionDefaultCount` divisor.
> - Retro timing: `parseMealDate` ("yesterday", day names) + retro-diet guard.
> - Corrections: slot relabels, quantity corrections ("2 eggs not 3"), removals,
>   `log_repeat_meal` ("same as lunch") — all deterministic.
> - Steps/water/weight: infer-and-log via `looksLike*` + `digitizeSpokenAmounts`.
>
> Closed 17 July: the 22:00–05:00 window demoted EVERY plate to "snack" — a
> night-shift client's 02:00 main meal included. Now: substantial late plates
> (≥300 kcal) and night-workers' plates (from `workSchedule`/`lifeSituation`)
> label as "night meal"; a 2am biscuit stays a snack. Unit-tested.

## The problem (founder's words, paraphrased)

The way real manual clients log food is *messy*. They fire off "2 eggs and pap"
or "had a kota" with **no meal name, no time, no portion** — and they're not
going to change. The bot must be smart enough to work out **when (which meal),
what, and how much** on its own.

- **If the client specifies** (meal, time, amount) → use it. Great.
- **If they don't** (the common case) → the bot **infers** intelligently instead
  of interrogating them.

This is not only about food. The same "infer, don't ask" intelligence should run
through **workouts, steps, water, weight** — the basics, done so well the client
barely has to think.

## Why it matters

A clueless beginner who has to specify "this is my lunch, about 150g" every time
will stop logging within days. Zero-friction logging is the difference between a
client who tracks for 7 months and one who quits in week 1. This is the core of
"intelligent coaching that does the basics extremely well."

## Current state — to confirm together (don't trust this list, verify it)

Today the bot already:
- Parses food from **text, photo, and voice** into kcal + protein.
- Understands explicit meal words ("for breakfast/lunch/dinner") and some
  retroactive dates ("yesterday", "this morning").
- Applies **goal-aware** portion context (fat_loss vs muscle_gain).

What feels inconsistent / unverified (the gap to close):
- **Meal slot when unspecified** — does "2 eggs and pap" at 07:30 auto-file as
  breakfast? At 13:00 as lunch? Is time-of-day used at all when no meal is named?
- **Portion when unspecified** — "a kota", "some rice" → what quantity is assumed,
  and is it tuned per food / per client history / per goal?
- **Timing** — same-day vs retroactive when ambiguous; "dinner same as lunch".

## Open questions for the discussion (the agenda)

1. **Meal-slot inference** — time-of-day heuristics? Gap since last logged meal?
   SA eating-pattern defaults? What about night-shift clients (already a segment)?
2. **Portion defaults** — per-food sensible defaults, adjusted by client's history
   and goal. Where do the numbers come from (the existing SA food macro table)?
3. **Confidence & when to clarify** — when does the bot quietly assume vs. ask one
   short question? A wrong silent assumption erodes trust; too many questions kill
   logging. Where's the line?
4. **Corrections** — "no, that was lunch" / "make it 2 portions" must cheaply
   override an inferred value without a reset.
5. **Consistency across food / workout / steps / water** — one inference philosophy,
   not four different behaviours.
6. **Guardrails** — never fabricate a composite meal (the existing
   `findFabricatedComposites` brake); inference must not inflate logged calories.

## Explicitly out of scope until we talk
No code changes to the food/meal pipeline off the back of this note. This exists
so the idea is captured precisely and we start the design conversation with a
shared picture.
