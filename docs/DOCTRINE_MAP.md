# Canonical Doctrine Map

**Status:** first pass, 2026-08-12. Every row below was verified against the code, not inferred.
**Frozen while this stands:** `server/coach-prompt.ts` — no restoring, moving, shortening or deleting.
**Where new doctrine goes:** the engine `CONSTITUTION`, which is delivered in full. Writing a rule
into the `COACH_K_SYSTEM` tail past character 20,000 is not restoring it — it reaches nobody.

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
| Persistent hunger — evidence | `hunger-evidence.assembleHungerEvidence` | deterministic data | engine prompt, **conditionally** (live.ts composes, engine serialises) | `gap-tests` state machine + gate | healthy |
| Persistent hunger — doctrine | `CONSTITUTION` Law 26 (`meaning-engine.ts`) | model doctrine | engine, every call, sent in full | `gap-tests` + `check-prompt-integrity` | healthy |
| Programme ≤ 3 WhatsApp messages | `reply-contract.MESSAGE_BUDGET` | deterministic invariant | `programme.ts` emitters | `unit-tests` (adversarial) | healthy* |
| Meal plan ≤ 4 WhatsApp messages | `reply-contract.MESSAGE_BUDGET` | deterministic invariant | `meal-plan.ts` | `unit-tests` (adversarial) | healthy |
| SA retail price estimates | `reply-contract.PRICE_ESTIMATE_NOTE` (framing) + `shopping-lists.ts` (literals) | deterministic data + invariant | shopping list, GPT rebuild | `unit-tests`, `check-pricing` freshness | healthy |

## The gaps, precisely

_Gap 4 closed 2026-08-12; gaps 2 and 3 closed by the message-budget invariant. Gap 1 remains._

**1. Persistent hunger → protein diagnosis.** The protein-leverage doctrine (*"the most likely
cause is under-eating protein, not lack of willpower"*, with the mechanism: 1,800 kcal at 50g
protein leaves the body hungry, 1,800 kcal at 130g satisfies) exists **only** in the silenced
region of `coach-prompt.ts`. Not in any live prompt, not in code. Two situational fragments
survive — a menstrual-phase note and a "you're short on protein" snack tip
(`misc-commands.ts:221,251`) — neither is the diagnostic claim.

This is the highest-value gap. It converts *"I have no willpower"* from a character verdict into
a fixable number, which is the reframe the weight-loss promise rests on. **Model doctrine**, not
deterministic — the reasoning is the product; only the protein numbers are data.

**2 & 3. Message caps — CLOSED 2026-08-12.** `enforceMessageBudget` re-packs sections without
dropping or reordering content: `buildFullProgramme` 5→2, `generateMealPlan` 5→2.

**\*** `getKamlifeProgramme` went 15→**4** against a cap of 3, and stops there honestly: 5,273
chars cannot fit 3×1,500 (nor 3×1,600, Twilio's hard cap). The overflow is logged with the numbers
rather than resolved by deleting coaching. Closing that last message is a CONTENT decision, and it
raises a doctrine question — the product object looks like *3 training days + a header*, i.e. four
bubbles, so the written "≤3" may be the incomplete half of the rule.

**4. SA grocery prices — CLOSED 2026-08-12.** Three epistemic classes now, and they are not
spoken alike: a NUTRITION VALUE is stable reference data (`foods.ts`) and is stated flatly; a
RETAIL ESTIMATE is a volatile local guess and must carry `PRICE_ESTIMATE_NOTE`; an OBSERVED PRICE
is what this client actually paid, which we do not collect yet. The asymmetry found was that
`formatShoppingList` (maintained literals) already hedged, while the GPT rebuild — whose numbers
the MODEL INVENTS — carried no qualifier at all. Both paths now use one owner for the sentence, and
`check-pricing.ts` fails when `PRICE_DATA_AS_OF` lapses past `PRICE_REVIEW_MONTHS`. Deliberately
NOT built: a live SA price feed. An honest estimate beats a fake fact.

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
- **The admin review queue labels every signal "a moment the bot fumbled"** — including friction,
  which `quality-signals.ts` claims is excluded. Symptom kinds are now filtered out via
  `NOT_A_BOT_FUMBLE`, but the underlying conflation is older and unresolved. **Open architecture
  debt; an operator/product decision, not a code one.**
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
