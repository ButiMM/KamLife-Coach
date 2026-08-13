# Persistent Hunger — canonical doctrine and evidence contract

**Status:** BUILT, 2026-08-12. Steps 1-5 shipped. The contract below is implemented in
`server/hunger-evidence.ts` — including the calorie fields, which were specified here and missed
in the first cut of the object; the gauntlet's construct-validation surfaced the omission.

**What it replaces.** The protein-leverage doctrine currently exists only in the silenced region
of `coach-prompt.ts` (character 25,843 of a prompt sliced at 20,000). It says: *"the most likely
cause is under-eating protein, not lack of willpower."* Restoring that sentence verbatim would
buy us a new brittle rule — `HUNGRY → EAT MORE PROTEIN` — which is the superficial AI coaching
this rebuild exists to get away from.

## The doctrine

> **Persistent hunger is a signal to investigate, not a moral failure and not proof that protein
> is the cause.** Protein adequacy is one diagnostic lever among several. Evaluate the evidence,
> choose the highest-leverage intervention, change one thing, observe the outcome, adjust.

```
persistent hunger
      ↓
investigate ── protein adequacy · calorie restriction · meal volume & composition
               meal timing · sleep & recovery · adherence / logging accuracy · context
      ↓
choose the highest-leverage lever
      ↓
change ONE thing
      ↓
observe outcome
      ↓
adjust
```

Three states the system must be able to tell apart. Collapsing them is how this becomes brittle:

| State | Evidence | Correct response |
|---|---|---|
| one-off low-protein day | 1 day below target, 7-day average fine | note it, do not intervene |
| persistent protein inadequacy | rolling average materially below target | protein is the lever |
| **hunger despite adequate protein** | rolling average at target, still hungry | protein is **not** the lever — look at volume, restriction, sleep, adherence |

That third row is the one that protects us. A rule that fires on protein whenever a client says
"hungry" will be confidently wrong for exactly the clients who already did what we asked.

## Layer split

**Deterministic layer calculates and exposes evidence. It never decides and never speaks.**
The model must not do arithmetic the nutrition layer can do exactly.

**Coach K interprets.** Symptom + evidence + context → one intervention → next move, in the
client's words. That reasoning is the product and it is not hardcodable.

## What already exists

Checked before designing, because half of this is built and unwired:

| Evidence | Exists? | Owner |
|---|---|---|
| protein TARGET | ✅ | `adaptive-targets.adaptTargets` → `proteinTarget`, goal- and illness-aware |
| today's protein intake | ✅ | `food-scanner.recomputeTodayFoodTotals`, `day-ledger.getDayLedger` |
| 7-day average protein | ✅ | `report-card.ts` — SQL `SUM(proteinInt)` over the window |
| calorie context | ✅ | same ledger reads |
| weight trend | ✅ | `weight.weeklyTrendSlopeKg`, `adaptive-targets.weightTrendUsable` |
| adherence / logging days | ✅ | `foodLogDays` in `progress-score.ts` |
| **multi-signal aggregation + bottleneck** | ⚠️ **built, never called** | `progress-score.computeProgressScore` |
| per-meal protein distribution | ⚠️ partial | `gpt.ts:1064` builds `byMeal` locally, not reusable |
| **symptom persistence ("hungry 6 days running")** | ❌ **missing** | nothing records a reported symptom over time |
| sleep | ❌ | not collected (`progress-score.ts` says so explicitly) |

**`computeProgressScore` is dead code.** It is fully specified — `avgDailyProtein` against
`proteinTarget`, adherence, steps, weight — and it already returns a **`bottleneck`**: the
lowest-ratio component with room to improve. That is precisely "the highest-leverage lever",
authored and never wired to anything. Same shape as the sliced prompt: capability the product
paid for and never shipped.

**Symptom persistence is the real missing piece**, not the arithmetic. Today "I'm hungry" is an
isolated message. The doctrine needs *"you have said this every afternoon for six days"*, and
`friction.ts` already has the pattern — `captureFriction` + `frictionCountsLast7` — but its kinds
are `correction | rejection | redirect | frustration`. No symptom kind exists.

## The evidence contract

Modelled on `AdaptiveInput`/`AdaptiveTargets`, which is the house pattern for a deterministic
contract: typed in, typed out, one plain sentence for the client, no prose from the calculator.

```ts
interface HungerEvidence {
  proteinTargetG: number;
  proteinAvg7dG: number | null;      // null = not enough logged days to claim anything
  proteinGapG: number | null;        // target − avg; negative = short
  loggedDays7d: number;              // 0–7. Below ~4 the averages are not evidence.
  calorieTarget: number;
  calorieAvg7d: number | null;
  restrictionRatio: number | null;   // avg ÷ target. Well under 1 = under-eating, not protein
  lowProteinMeals: string[];         // slots consistently below their share
  weeklyKgChange: number | null;
  trendUsable: boolean;              // from weightTrendUsable — do not claim a trend without it
  symptomDays: number;               // consecutive days hunger was reported. 1 ≠ 6.
  confidence: "none" | "weak" | "usable";  // derived from loggedDays7d + trendUsable
}
```

**`confidence` is load-bearing.** With `loggedDays7d < 4` the honest answer is *"I do not have
enough logged to tell you why"* — asking for one day's log is a better intervention than a
confident guess. A contract that cannot say "I don't know" will invent an answer.

## Acceptance cases

Written as behaviour, deliberately including the cases that must **not** fire:

1. **Persistent inadequacy.** 7 logged days, target 120g, avg 71g, calories near target, hungry 6
   days → names the gap, raises protein and volume, does **not** cut calories.
2. **Adequate protein, still hungry.** avg 118g against 120g, hungry 5 days → must **not** say
   protein. Moves to volume, restriction, sleep, adherence.
3. **Over-restriction.** calorieAvg7d 1,150 against 1,800, protein fine → the lever is
   under-eating; raising protein alone would be wrong.
4. **One bad day.** 1 day at 60g, 7-day avg 115g, hunger reported once → acknowledge, no
   intervention. Firing here is the brittleness we are avoiding.
5. **Insufficient data.** loggedDays7d = 2 → says so plainly and asks for logs. No diagnosis.
6. **No hunger reported.** evidence assembled but symptom absent → nothing volunteered.
7. **Never moralises.** No case may produce willpower, discipline, or "stay strong" language.

## Build order, if approved

1. **Wire `computeProgressScore`** and feed `avgDailyProtein` from the `report-card` aggregate —
   it is written, tested-shaped, and its `bottleneck` is the lever selector. Cheapest real step.
2. **Symptom persistence** — extend the `friction.ts` pattern with a symptom kind so
   `symptomDays` is real rather than inferred from one message.
3. **`HungerEvidence` assembler** — pure, one owner, no writes.
4. **Doctrine into the prompt** — the diagnostic sequence, not the conclusion. It must land
   inside a delivered region and be registered in `check-prompt-integrity.ts` with a body
   sentinel, or it repeats the exact failure it is fixing.
5. **Acceptance cases** as deterministic tests where evidence assembly is testable, and as
   Reality journeys where interpretation is.

Nothing here touches `coach-prompt.ts` while it is frozen. Step 4 is the only step that needs
that freeze lifted, and it should be lifted deliberately, for that step, with the guard updated in
the same commit.
