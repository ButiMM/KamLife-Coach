# KamLife Operating Contract

This repository builds KamLife Coach. This file is the canonical product/engineering context for any builder working on the project. Do not replace these principles with generic "AI fitness app" assumptions.

## Product thesis

KamLife is **continuous decision-making under incomplete information**.

The product does not win by teaching more weight-loss information. It wins by reconstructing enough of a client's messy real life to make the **least intervention justified by the evidence**.

The customer should be able to tell KamLife what happened naturally: text, voice notes, late logs, corrections, partial days, photos without captions, missed periods, social events, training constraints, budget constraints, and re-entry after absence. KamLife organizes the mess; the client should never have to learn the database model.

## Competitive position

Do not treat these as KamLife moats:
- WhatsApp
- South African food data
- photo food logging
- corrections / past-date logging
- weight tracking
- web dashboard
- generic AI nutrition answers

Local competitors such as FitSorted already demonstrate much of that surface area. Global products such as MyFitnessPal, Noom, BetterMe and other AI fitness apps demonstrate that tracking, personalization and content are commodity directions.

KamLife's intended distinction is:

**Tracker:** what did you eat and how does it fit the target?

**KamLife:** given what is actually happening in your life, what is the single most useful next action — including "change nothing" or "I don't know yet"?

Do not chase feature parity. Improve the coaching loop.

## Permanent doctrine

1. **Information is not the product. Decisions are.**
2. **Weight is the outcome signal; food and behaviour are explanatory evidence.** Use trend, not a single noisy scale reading.
3. **Missing data is not proof of behaviour.** Understand why a gap exists before interpreting it.
4. **The most common correct decision may be CONTINUE / change nothing.** Do not manufacture novelty.
5. **"I don't know yet" is a successful outcome** when evidence is insufficient.
6. The decision engine chooses the **least intervention justified by the evidence**.
7. Only collect/store/surface information that could change the next instruction.
8. Re-entry is frictionless and shame-free. No broken-streak framing. No mandatory backfill.
9. Education is just-in-time, in the context where the client needs it.
10. Safety/referral is a first-class outcome, not a prompt afterthought.
11. Photos are baseline/progress context, not an oracle for "ideal weight".
12. GLP-1 and other medication context belongs in the safety/context layer. Never dose, titrate, source, or substitute medication.
13. The customer should be able to see what KamLife currently knows about them.

## Canonical decision states

Every meaningful coaching decision should resolve to one of:

- **CONTINUE** — current plan is working; preserve it.
- **CHANGE** — one highest-leverage action is justified.
- **INVESTIGATE** — evidence is insufficient; ask for the minimum useful missing fact.
- **REFER / ESCALATE** — outside KamLife's safe coaching scope.

A generic LLM answer is not a valid substitute for choosing one of these states.

## Core loop

```text
messy human input
    -> canonical events
    -> temporal reconstruction + provenance + uncertainty
    -> longitudinal state
    -> evidence sufficiency
    -> decision state
    -> one useful next action (or continue)
    -> outcome observation
    -> adaptation
```

## Engineering priorities

Build in this order unless a production blocker forces otherwise:

1. Event model with provenance, uncertainty and temporal correction.
2. Reliable retrieval, corrections and aggregates.
3. Decision loop with CONTINUE / CHANGE / INVESTIGATE / REFER.
4. Natural multimodal logging (text, voice, image) that preserves truth.
5. Longitudinal memory/state that knows where coaching paused.
6. South African food/context intelligence where it changes decisions.
7. Adaptive targets/training and deeper coaching.
8. Transparent visual client state ("what KamLife knows").

## Architecture rules

- Preserve reality first. Never invent, merge, or silently reinterpret user facts.
- Provenance is mandatory: distinguish verified/database facts from model estimates and unknowns.
- Temporal facts need one canonical South Africa day/time boundary. Do not create a second day-key owner.
- Do not pass irrelevant aggregates into the coach simply because they exist.
- Deterministic code should measure/report; the coach should decide whether a measurement is materially actionable unless policy explicitly requires deterministic intervention.
- Do not create a hidden second owner of an existing domain decision. Reuse canonical helpers/state owners.
- A feature is not "done" because a prompt mentions it. Evidence must arrive in the live path and the behaviour must be tested.
- Behaviourally verified and structurally implemented are different states.
- Do not claim a live model test passed when the model was not actually exercised.
- Production blockers get fixed before feature work.

## Testing standard

For important coaching doctrines, verify the entire chain:

1. doctrine defined;
2. evidence calculated;
3. evidence stored/retrieved;
4. evidence injected into the actual live path;
5. model receives it;
6. output is checked mechanically where possible;
7. live-model behaviour is explicitly labelled verified or unverified;
8. permanent regression coverage captures the learned failure.

## Core failure patterns already discovered

The repository history contains real examples of failures that must not return:
- UTC vs SAST day-boundary contradictions.
- `pre-workout` interpreted as a supplement instead of a time context.
- portion phrases such as "2 spoons of pap" inflated into multiple full portions.
- estimated calories presented as database-verified without provenance.
- adaptive target changes made when intake evidence was insufficient or clearly above target.
- "weakest lever" / argmin-style fields steering the coach toward a change when no material problem existed.
- Law 26 hunger reasoning being stated in the prompt without the required evidence actually arriving in the model input.
- production build failure caused by Railpack secret resolution; the production path now uses the repository Dockerfile rather than Railpack inference.

Treat these as regression knowledge, not historical trivia.

## Product success test

The core journeys must become exceptionally reliable:
- messy multi-meal voice dump;
- late / corrected / backdated logging;
- sparse logging with a usable weight trend;
- flat trend with insufficient food evidence;
- apparent stall with intake clearly above target;
- one-off alcohol/social event without overreaction;
- repeated weekend pattern with enough evidence to act;
- two-week absence and clean re-entry;
- medication/GLP-1 context with safe boundaries;
- a genuinely on-track client receiving the correct advice: **change nothing**.

## Builder instruction

When a task conflicts with this contract, stop and surface the conflict before implementing it. Prefer the smallest change that strengthens the decision loop and preserves existing architecture. Do not add features merely because competitors have them. Ask: **"Does this change what we would tell this person to do next?"** If not, it probably does not belong.
