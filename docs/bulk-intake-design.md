# Bulk Intake — one-paste onboarding (design, ready to build)

**Why (2026-07-07, from production):** a real manual client sent her ENTIRE intake
as one colon-separated blob — name, age, weight, goal, dream range, home
equipment, no step tracking, WFH sedentary, beginner, no medical, meal pattern,
dairy hate, occasional drinker, start date:

> "Natasha:29:90kg:fat loss:70 to 75 dream goal:No gym at the moment:have
> trailmil at home:I dnt have track of my steps:sit most of the day as am woe
> from home office work:beginner training experience:no medical condition and no
> past injuries:I normally eat from from lunch:I love protein food and hate
> dairy:I drink occasionally:I struggle with all of the above:want to start anytime"

This is how real SA clients onboard — one messy paste, not twelve neat answers.
Today the FSM would treat that blob as the answer to ONE question (her *name*),
discard eleven volunteered facts, and re-ask them all. First-impression killer,
and the exact opposite of the positioning ("You don't track. It remembers.").

## Behaviour

1. **Detect** (deterministic, cheap): during any onboarding state — and for a
   brand-new number's first message — flag a message as bulk intake when
   `length > 120` AND ≥3 of: age-like number (`\b[1-6]\d\b`), weight (`\d{2,3}\s*kg`),
   goal words (fat loss/lose/muscle/gain/tone), equipment/gym words, medical/injury
   words, `:` count ≥ 4.
2. **Extract** (one gpt-4o call — first impression justifies the big model; fires
   at most once per client ever): strict JSON — name, age, gender?, weightKg,
   heightCm?, goalType, targetWeightLow/High, trainingMode (gym/home/equipment
   list), stepsTracked?, activity/occupation, experience, medicalConditions,
   injuries, eatingPattern, foodDislikes, alcohol, startIntent.
   **Hallucination brake (same rule as the normalizer): every extracted value must
   literally appear in the source text; drop any that don't.**
3. **Confirm** (one message): "Here's what I got: … — reply YES to lock it in, or
   correct anything." Never silently commit a model extraction.
4. **On YES**: write fields, compute targets via `calculateTargets`, jump the FSM
   past every answered state, ask ONLY what's missing (usually height + email).
   Preferences/dislikes ("hates dairy") go to `storeMemory` so meal plans respect
   them forever.

## Hard rules

- **POPIA consent is NEVER auto-skipped** — the consent step still happens
  explicitly before anything is stored.
- Underage gate still enforced on the extracted age.
- Fails OPEN: any extraction error/timeout → normal question-by-question FSM,
  nothing lost.
- Killswitch: `BULK_INTAKE=off` in Railway.
- Phase 2 (separate): founder-forward — Kam pastes a client's blob from the admin
  side and the profile is created for their number.

## Tests

- Unit: the detector heuristic — Natasha's blob (golden case, anonymised) must
  detect; "I had eggs and pap for breakfast" and long chatty messages must NOT.
- Unit: the hallucination brake — extraction containing a field not present in
  the source is dropped.
- Routing: bulk blob mid-onboarding never lands in the name/age handlers.

## Why not built the night it was specced

`onboarding.ts` is the never-touch-blind file (first impression), it was 02:00,
and this needs the confirmation UX + tests above. A blind FSM patch was the
higher risk. Build next session, top of the list.
