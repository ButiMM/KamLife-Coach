# Canonical Doctrine Map

**Status:** first pass, 2026-08-12. Every row below was verified against the code, not inferred.
**Frozen while this stands:** `server/coach-prompt.ts` — no restoring, moving, shortening or deleting.

## Why this exists

"Where does Coach K get the truth that persistent hunger should trigger a protein diagnosis?"
took a script and five files to answer. That is the actual architectural problem — not prompt
size. Doctrine is spread across five prompt layers and a dozen deterministic modules with no
index, no ownership, and no test that any given rule reaches a model.

This map answers three questions per rule: **who owns the truth**, **how it is enforced**, and
**which live paths receive it**.

## Terminology — read this before using the map

**`NEVER SENT` does not mean dead.** It means *not delivered to that model path*. The doctrine may
be intentionally owned by `agents.ts`, by deterministic code, by another prompt, or eventually by
a canonical doctrine layer. Treating "not in `STATIC_HOT_BRAIN`" as "safe to delete" is the single
most expensive mistake available here — for six of the eight protected sections, the silenced copy
is the **only** copy.

**Enforcement modes**, and the separation we are building toward:

| Mode | Belongs to | Example |
|---|---|---|
| **deterministic data** | code owns the number | `chicken breast 100g = 165 kcal, 31g protein` |
| **deterministic invariant** | code owns the guarantee | `a programme must not exceed 3 WhatsApp messages` |
| **model doctrine** | the prompt owns the reasoning | `persistent hunger → investigate protein before willpower` |
| **model behaviour** | the model owns the delivery | `explain it in their language, in their context` |
| **dual** | prompt states it, code backstops it | Law 22 — no hand-back question |

A rule may be stated in several places and still have one canonical owner. **Duplicated wording is
not duplicated authority.** Consolidation is only safe where authority is genuinely duplicated.

## The layers doctrine currently lives in

Five prompt layers reach a model. Measured, evaluated character counts:

| Layer | Static size | Path | Note |
|---|---|---|---|
| `COACH_K_SYSTEM` (`coach-prompt.ts`) | 67,677 → **20,000 sent** | `askCoachK` | sliced; 47,677 reach no model |
| `BRAIN_SYSTEM` (`brain/coach-brain.ts`) | 29,761 | meaning engine | sent in full, every call |
| `SCENARIO_GUIDE` (`handlers/gpt-block.ts`) | 26,090 | `askCoachK` via gpt-block | sent in full |
| `CONSTITUTION` + `THINK_HEADER` (`understanding/meaning-engine.ts`) | 8,478 + 2,440 | meaning engine | the Laws live here |
| `ACTION_DIRECTIVE` (`understanding/actions.ts`) | 3,226 | meaning engine | only when tools are on |
| specialist prompts (`agents.ts`) | — | `gpt-block` → `routeToAgent` | **the layer easiest to miss** |

Engine path static total: **43,905** — and `writeReplyAfterTools` re-sends it, so a logging turn
pays it **twice**.

## The map

| Doctrine | Canonical owner | Enforcement | Live consumers | Tests | Status |
|---|---|---|---|---|---|
| Food values (kcal/protein) | `foods.ts` | deterministic data | food scanner, macro paths | `food-scanner-tests` 48 | healthy |
| SAST day boundary | `sast.ts` | deterministic data | every dated read/write | `check-sast` guard | healthy |
| Step targets by goal | `targets.ts` + `goal-profiles.ts` | deterministic data | onboarding, targets | `unit-tests` | healthy |
| Subscription price (R199) | `shared/pricing.ts` | deterministic data | billing, dashboard | `check-pricing` guard | healthy |
| Law 22 — never hand the work back | `CONSTITUTION` L22 | dual (prompt + `tellDontAsk`) | engine reply paths | `unit-tests` | healthy |
| Law 25 — one next move per reply | `CONSTITUTION` L25 | dual (prompt + `theNextMove`) | engine reply paths | `unit-tests` | healthy |
| Law 14 — tool call still writes a sentence | `CONSTITUTION` L14 + `ACTION_DIRECTIVE` | dual (prompt + `writeReplyAfterTools`) | engine tool turns | `unit-tests` | healthy |
| Guard #8 — tools return facts, never prose | `understanding/actions.ts` types + `refsAreLabels` | deterministic invariant | executor | `unit-tests` | healthy |
| Safety / escalation detection | `safety-detection.ts` | deterministic invariant | every inbound message | `safety-audit` 82 | healthy |
| Synthetic test clients never page | `safety-detection.isSyntheticTestClient` | deterministic invariant | `chat-log.checkEscalation` | `gap-tests` | healthy |
| Explicit meal slot beats the clock | `understanding/actions.explicitMealSlot` | deterministic invariant | executor, `food-context` | `gap-tests` | healthy |
| Grocery list is not a meal | `routes.ts` grocery gate | deterministic invariant | inbound pipeline | `routing-audit`, `gap-tests` | healthy |
| SA localisation of suggestions | `food-swaps.localiseSuggestion` + `matchRestaurant` | deterministic, context-aware | engine reply paths | `unit-tests` | healthy |
| Banned bot phrases | **split — see gaps** | deterministic invariant | food scanner, coach brain | `unit-tests` | **fragmented** |
| Prompt doctrine delivery | `check-prompt-integrity.ts` | deterministic invariant | n/a (guard) | wired into `npm test` | healthy |
| Persistent hunger → protein | **none** | — | **none** | **none** | **GAP** |
| Programme ≤ 3 WhatsApp messages | **none** | — | **none** | **none** | **GAP** |
| Meal plan ≤ 4 WhatsApp messages | **none** | — | **none** | **none** | **GAP** |
| SA grocery item prices | `shopping-lists.ts` (hardcoded) | none — literals | shopping list replies | **none** | **GAP** |

## The gaps, precisely

**1. Persistent hunger → protein diagnosis.** The protein-leverage doctrine (*"the most likely
cause is under-eating protein, not lack of willpower"*, with the mechanism: 1,800 kcal at 50g
protein leaves the body hungry, 1,800 kcal at 130g satisfies) exists **only** in the silenced
region of `coach-prompt.ts`. Not in any live prompt, not in code. Two situational fragments
survive — a menstrual-phase note and a "you're short on protein" snack tip
(`misc-commands.ts:221,251`) — neither is the diagnostic claim.

This is the highest-value gap. It converts *"I have no willpower"* from a character verdict into
a fixable number, which is the reframe the weight-loss promise rests on. **Model doctrine**, not
deterministic — the reasoning is the product; only the protein numbers are data.

**2 & 3. Message caps.** *"Maximum 3 messages for any programme"* and *"Maximum 4 messages"* for
meal plans exist nowhere live. `programme.ts` emits **10** `---` separators, so a programme can
ship as ten WhatsApp messages against a rule of three. These are **deterministic invariants** —
they belong in code as output constraints, like food values. A rule the emitter can violate is
not a rule.

**4. SA grocery prices.** `shopping-lists.ts` carries hardcoded item prices (`R45` chicken, `R12`
cabbage) and hardcoded `estimatedTotal` strings. `check-pricing.ts` does **not** cover these — it
guards the subscription price only. So there is no canonical owner and no staleness guard for the
numbers the product quotes a client at the till. Either an authoritative source or explicit
"approximate estimate" framing; today it is neither.

## Fragmentation found while mapping

Recorded because each is a place where "one question, one owner" is not yet true:

- **Banned phrases have two enforcers.** `coach-guardrails.BANNED_PHRASES` (a table, used by
  `food-scanner` and `coach-brain`) and separate inline `.replace()` calls inside
  `sanitizeCoachReply` (`food-scanner.ts:464+`) which strip *different* phrases
  (`"You've got this"`, `"How does that sound"`) and rewrite category jargon. Same question, two
  tables, neither aware of the other.
- **Scenario scripts are stated three times.** `COACH_K_SYSTEM`, `BRAIN_SYSTEM` and
  `SCENARIO_GUIDE` each independently cover bereavement, genetics, GLP-1, holidays and
  digestive issues in different words, with no imports between them. **This is the one place
  where duplication is genuine** and consolidation would be safe — subject to checking which
  copy each live path actually receives.
- **`agents.ts` is a fifth prompt layer** carrying programme philosophy the 20k slice drops. It
  was missed in the first audit pass and materially changed the conclusion (13 "orphaned"
  concepts fell to 3 once it was included).

## Maintaining this

When adding or moving doctrine, answer all five columns before writing the rule:

1. **Owner** — one file. If the answer is "the prompt and also this handler", say which is
   authoritative and which is the backstop.
2. **Mode** — data, invariant, doctrine, behaviour, or dual. Numbers are data. Guarantees are
   invariants. Reasoning is doctrine.
3. **Live consumers** — which paths actually receive it. `check-prompt-integrity.ts` answers this
   for the eight protected sections; nothing answers it for the rest yet.
4. **Test** — a rule with no test is a suggestion. This codebase has relearned that repeatedly.
5. **Status** — and if it is a gap, say so here rather than leaving it implied.

**Do not** add a sixth prompt layer, a second detector for an answered question, or a regex that
duplicates an existing predicate. Every one of those was a defect found in this workstream.
