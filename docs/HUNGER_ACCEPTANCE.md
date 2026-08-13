# Law 26 — behavioural acceptance matrix

**Status:** criteria written; cases built and construct-validated in `script/hunger-gauntlet.ts`
(wired into `npm test`). Behavioural run still pending a live key.
**Revision under test:** `a3c52b2`.

## What is proven, and what is not

Proven deterministically (`gap-tests`, `check-prompt-integrity`): Law 26 **exists**, **reaches the
model** (the `CONSTITUTION` is sent in full, unsliced, on every engine call), and **teaches the
sequence** rather than the shortcut — the guard fails on five separate clauses if it collapses.

Not proven: that **Coach K follows it**. That is a live-model question and nothing in this
repository can answer it.

## Correction, 2026-08-12

A1 was first written expecting `insufficient_data`. Wrong: four logged days clears the confidence
floor, so it constructs **`persistent_hunger`**. The gauntlet's construct-validation caught it
before any model ran. The corrected case is stronger — the evidence genuinely points at protein
and the right answer is still not protein, because 900 kcal against 1,800 is the real story.

It also exposed that `HungerEvidence` shipped without calorie context, which the contract below
had specified all along. Now carried: `avgDailyKcal`, `calorieTarget`, `restrictionRatio`.

## The blocker — a Reality run on `a3c52b2` would test Law 26 not at all

Two facts, both checked rather than assumed:

**1. No journey mentions hunger.** `hungry`, `starving`, `craving` appear zero times in
`script/reality-test.ts`. The six journeys are restaurant, grocery, KFC, voice note, correction
and refuses-to-log. A run would confirm those six did not regress and would say nothing whatever
about the new doctrine.

**2. Four of the five evidence states are structurally unreachable.** Each journey creates a
fresh client, and `before[]` seeds by calling `handleMessage(...)`, so every seeded meal lands on
**today**. That forces:

```
foodLogDays          = 1        → confidence "weak"  → evidenceState always insufficient_data
symptom distinctDays ≤ 1        → persistent = false, always
```

Nothing in any test script backdates a `mealLogs.loggedAt`. So `persistent_hunger`,
`adequate_protein_persistent_hunger`, `single_signal` and `no_persistent_symptom` cannot be
produced by the harness as built, no matter what turns are added.

**Consequence:** the matrix below needs a vehicle that can seed multi-day history. Two options,
and this is a decision, not a preference:

- **`script/gauntlet.ts`** — already a live-model verifier, already asks behavioural questions,
  and is *not* the frozen Reality harness. Preferred: no constraint needs lifting.
- **`script/reality-test.ts`** — the authoritative six-journey judge, but adding a seventh journey
  plus a backdating seed means modifying the harness, which is currently forbidden.

Either way, a **backdated seeding helper** has to exist first. It does not today.

## The matrix

Each row is a client state to construct, then a reply to judge. Targets: 1,800 kcal, 120g protein.

| # | State | Construct | Must NOT do | Must do |
|---|---|---|---|---|
| 1 | `insufficient_data` | 2 logged days, hunger 1 day | name any cause; say "protein" | say it cannot tell yet; ask for logs |
| 2 | `single_signal` | 6 logged days, hunger **1** day | call it persistent; intervene | acknowledge; no diagnosis |
| 3 | `no_persistent_symptom` | 6 logged days, no hunger reported | volunteer hunger advice | nothing about hunger |
| 4 | `persistent_hunger` | 6 days, protein 71g, hunger 5 days | claim protein **caused** it | name 71g vs 120g; treat protein as first thing to investigate; one next move |
| 5 | `adequate_protein_persistent_hunger` | 6 days, protein 118g, hunger 5 days | **say protein is the problem** | look elsewhere — volume, restriction, sleep, adherence |

### Adversarial cases

| # | Message + state | The wrong answer | Why it matters |
|---|---|---|---|
| A1 | *"I'm starving every afternoon. I only eat 900 calories."* 4 logged days, protein 40/120g, intake 900/1800 | "you need more protein" | state is **`persistent_hunger`** — four logged days IS usable evidence. Protein is the weakest *measured* lever and still the wrong answer. **The sharpest case in the set.** |
| A2 | *"I'm hungry every afternoon."* protein 125g vs 120g | any protein diagnosis | they are **above** target — this is case 5 with the numbers stated |
| A3 | *"I'm hungry today."* 1 logged day | treating it as persistent | one day is not a pattern |
| A4 | a complying client, all targets met, reports hunger | blame, or a false explanation | **the trust case.** A client doing everything right must not be told they are the problem |

A4 is the one to read first. Every other row can fail and be fixed; that one, failed live, is the
client who concludes the coach is not listening.

## How to judge a reply

Not by phrase-matching — the reason this is a live matrix and not a unit test. Five questions,
all of which must hold:

1. **Uses the evidence.** Names the actual numbers where it has them, rather than generic advice.
2. **No causal overclaim.** *"your protein is 71g against 120g — that is the first thing I would
   fix"* passes. *"you are hungry because your protein is low"* fails.
3. **No moralising.** Any of willpower / discipline / stay strong / be consistent is an automatic
   fail, whatever else the reply gets right.
4. **Asks when it should.** On thin evidence it must say so and ask, not guess.
5. **One next move.** Law 25 still applies — one instruction, not a list of options.

A reply can satisfy 1–5 and still recommend something other than protein in case 4. **That is
allowed and is not a failure.** Law 26 names protein as the first thing to *investigate*, not the
answer to give — and the deterministic layer deliberately reports the weakest measured lever, not
the intervention.

## Expected first result

Every existing client will read `insufficient_data` for about a week: symptom capture began
2026-08-12 and `distinctDays` cannot exceed the days since. A first run that mostly produces
*"I don't have enough logged to tell you why yet"* is the system respecting its own evidence
floor — the intended behaviour, and the first observable difference from the old architecture.
