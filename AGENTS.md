# KamLife Operating Contract

This repository builds KamLife Coach. This file is the canonical product/engineering context for any builder working on the project. Do not replace these principles with generic "AI fitness app" assumptions.

## Product thesis

KamLife is **continuous decision-making under incomplete information**.

The product does not win by teaching more weight-loss information. It wins by reconstructing enough of a client's messy real life to make the **least intervention justified by the evidence**.

The customer should be able to tell KamLife what happened naturally: text, voice notes, late logs, corrections, partial days, photos without captions, missed periods, social events, training constraints, budget constraints, and re-entry after absence. KamLife organizes the mess; the client should never have to learn the database model.

## Actual KamLife customer

KamLife is built for ordinary people with imperfect lives, not professional loggers.

Most clients will **not** log every breakfast, lunch, dinner, workout, and step on time. They may:
- disappear for several days;
- return and report multiple days in one message;
- send one voice note containing several meals across several dates;
- remember a missing item later;
- provide partial days rather than complete days;
- backfill yesterday, Saturday, or earlier in the week;
- report a social event after it happened;
- mix food, workouts, steps, feelings, plans, corrections, and questions in one message;
- give incomplete information and expect the Coach to work with it.

**This is normal KamLife usage, not an edge case.**

The client's job is to live. KamLife's job is to reconstruct enough of the life being reported to maintain truthful state and provide useful coaching.

Never design the product around teaching clients to become perfect data-entry users. The system must absorb messiness, delay, incompleteness, corrections, and multi-day reports without requiring the client to learn database language.

## Product promise

KamLife is a **proactive WhatsApp Coach at the mass-market South African price point**.

The Coach should:

> understand what the client just told it → reconstruct what matters → decide the next move → tell the client **what to do, how to do it, and when to do it**.

The client should not have to say:
- "coach me";
- "what should I do?" after every situation;
- "log this" in database-shaped language;
- "please remember this" for ordinary continuity;
- "tell me what the next step is" when the next step is already obvious from the situation.

The ideal interaction is an ongoing human coaching conversation, not a support form and not a tracker asking the client to operate the tracker.

KamLife does **not** need supernatural intelligence. It needs dependable comprehension, continuity, judgement, and proactive direction.

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

## Permanent product doctrine

1. **Information is not the product. Decisions are.**
2. **The client does not manage the system.** KamLife interprets and organizes their natural reporting.
3. **Messy, delayed, partial, and multi-day reporting is first-class input.**
4. **Missing data is not proof of behaviour.** A gap means an observation is missing, not that the client failed.
5. **A missing log does not make the client a problem to be scolded.** Re-entry is frictionless and shame-free.
6. **Every meaningful situation should end in a useful next move when evidence supports one.** The Coach should lead rather than repeatedly ask the client to instruct it.
7. **The next move includes what, how, and when whenever that distinction is useful.**
8. **The least intervention justified by the evidence wins.** Do not manufacture novelty or tasks merely to make the Coach look busy.
9. **CONTINUE / change nothing is a successful coaching outcome.**
10. **INVESTIGATE is a successful outcome** when one minimum fact is required before a safe decision.
11. **Abstain rather than invent.** A truthful "I don't have enough to say that yet" is preferable to a confident fabrication.
12. **One Coach.** No specialist, command handler, morning branch, card renderer, or fallback may quietly become a second behavioural authority.
13. **A renderer cannot infer intent.** It may render a requested object, but behavioural direction belongs to the canonical Coach decision.
14. **The client should be able to see what KamLife currently knows about them.**
15. **Weight is the outcome signal; food and behaviour are explanatory evidence.** Use trend, not a single noisy scale reading.
16. **Safety/referral is a first-class outcome, not a prompt afterthought.**
17. **Education is just-in-time and subordinate to the coaching decision.**
18. **Corrections should be conversational.** The client should be able to say "you forgot the coffee" instead of re-entering an entire meal.
19. **Temporal correctness is mandatory.** A backdated fact must never silently become today's fact.
20. **A client can report multiple domains and multiple dates in one message.** Preserve every attributable fact before choosing the reply.

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

## Canonical interaction model

The product is not "one message = one intent".

One client message may contain:

```text
food + workout + steps + correction + history + question + future plan
```

The system must:

```text
understand all applicable facts
    -> write every applicable durable mutation
    -> reconstruct dates and uncertainty
    -> update current state
    -> identify the current request / constraint
    -> choose one coaching outcome
    -> produce one coherent response
```

A question elsewhere in a message must not veto a stated fact elsewhere in the message.
A fact elsewhere in a message must not force a coaching answer where the client explicitly asked for a factual retrieval.

## Temporal and retroactive reporting doctrine

Use one South African temporal owner.

A date reference can mean:
- today;
- a named past date;
- yesterday / last night;
- an explicit future date;
- an ambiguous span such as "last week".

Rules:
- A named date is written to that date.
- A span without a specific day is preserved as a span or clarified; never silently pinned to a day.
- "Today" means the SAST calendar day.
- Yesterday's correction must amend yesterday, not today's most recent row.
- A correction with a named meal slot must amend the relevant meal, not merely the most recent meal of another slot.
- An explicitly retrospective report may never overwrite current-day state without evidence.

## Messy logging doctrine

### Food

Accept and correctly interpret:
- one meal;
- several meals in one message;
- several days in one message;
- partial meal descriptions;
- late corrections;
- social/event meals;
- photos without captions;
- voice-note dumps.

### Training

Accept:
- several dated workouts reported together;
- a week-level completion statement;
- a correction to a prior workout;
- a future schedule change;
- a refusal/rest day;
- a workout retrieval request.

Never confuse:
- reporting that training happened;
- saying training will happen later;
- refusing training today;
- asking whether a session may be moved;
- asking to see the workout object.

### Steps / weight / other evidence

The same doctrine applies: preserve the correct date and source, even when the client reports several observations together or several days late.

## Proactive coaching doctrine

06:00 is not a compliance dashboard.

A proactive message should use the smallest coherent set of:
- yesterday / last-night reality;
- current day and schedule;
- current week's truthful state;
- latest explicit constraint;
- salient recent life context;
- the canonical decision.

It must not independently create:
- a second progress clock;
- a second workout decision;
- a second food decision;
- a second behavioural instruction;
- generic lapse/shame framing for an engaged client.

The Coach should remain useful even when the client logged very little.

If evidence is sparse, the Coach becomes **smaller and more useful**, not more bureaucratic.

## Architecture rules

- Preserve reality first. Never invent, merge, or silently reinterpret user facts.
- Provenance is mandatory: distinguish verified/database facts from model estimates and unknowns.
- Temporal facts need one canonical South Africa day/time boundary. Do not create a second day-key owner.
- Do not pass irrelevant aggregates into the coach simply because they exist.
- Deterministic code should measure/report; the coach should decide whether a measurement is materially actionable unless policy explicitly requires deterministic intervention.
- Do not create a hidden second owner of an existing domain decision. Reuse canonical helpers/state owners.
- **Handlers should primarily parse, classify, mutate state, or retrieve explicit objects. They should not quietly become behavioural Coaches.**
- A renderer may answer an explicit retrieval request. It may not infer that the client wants the underlying behaviour.
- A feature is not "done" because a prompt mentions it. Evidence must arrive in the live path and the behaviour must be tested.
- Behaviourally verified and structurally implemented are different states.
- Do not claim a live model test passed when the model was not actually exercised.
- Production blockers get fixed before feature work.
- Do not solve recurring defects with synonym-by-synonym regex accumulation. Fix the ownership or evidence boundary.
- Do not raise a guard budget merely to make CI green. Extract, delete, consolidate, or re-baseline only when the measurement itself was wrong and the true figure is recorded.

## Builder operating rules

When working in this repository:

1. **Evidence first.** Show the actual execution path and owner before changing code.
2. **No half-fixes.** A contract is closed only when the surrounding invariant and negative controls prove it.
3. **No invented subsystem.** Reuse the existing state/decision owner unless a structural failure proves it cannot work.
4. **No fake green.** Tests must exercise the live path, durable write, state, or final response as appropriate.
5. **No silent scope expansion.** If a change exposes a new problem outside the current slice, record it; do not quietly absorb it into the fix.
6. **No founder-as-QA.** Automated proof belongs in the repository. The founder's phone use is product evidence, not a recurring manual regression suite.
7. **A real client sentence matters more than a beautiful function test.** When a phone failure reveals an unowned contract, trace it to the owner.
8. **If two components can independently decide what the client should do, the architecture is not closed.**
9. **Do not treat the client as a professional logger.** Natural language, delayed reports, partial data, and multi-day dumps are normal inputs.
10. **When a task is finished, state exactly what remains open.** Never imply the architecture is complete when meaningful owners remain outside the contract.

## Engineering priorities

Build in this order unless a production blocker forces otherwise:

1. Event model with provenance, uncertainty and temporal correction.
2. Reliable retrieval, corrections and aggregates.
3. Decision loop with CONTINUE / CHANGE / INVESTIGATE / REFER.
4. Natural multimodal logging (text, voice, image) that preserves truth for messy real-world use.
5. Longitudinal memory/state that knows where coaching paused.
6. Proactive coaching that tells the client what to do, how, and when without requiring a coaching command.
7. South African food/context intelligence where it changes decisions.
8. Adaptive targets/training and deeper coaching.
9. Client journey and milestone cards with a canonical NEXT from the same decision owner.
10. Goal-runway estimates only when evidence is sufficient.
11. Shareable milestone cards + QR + attributable join flow.
12. Closed beta measurement, creators, then Meta/paid distribution.

## Product journey direction

### Day 0

Talk naturally. If something can be logged, log it. One coherent reply. No database homework.

### Day 1

06:00 should know what happened yesterday and give one useful next move.

### Day 7

First meaningful proof of participation/consistency. A card may appear only if earned.

### Day 14

With sufficient weight evidence, an **estimate** of goal runway may become useful. Never fabricate an arrival date from weak evidence.

### Day 30

Identity/progress moment: the client can see what has changed and what comes next.

### Later

Re-entry remains frictionless. Absence should make the Coach smaller and easier to restart, not punitive.

## Milestone cards and distribution

Cards are part of the product journey, not a separate marketing department.

A milestone card must be:

```text
TRUE       → based on authoritative progress state
USEFUL     → one earned fact
CELEBRATORY → recognition without empty hype
NEXT       → the same canonical next move used by the Coach
SHAREABLE  → client-owned; never auto-bragging
ATTRIBUTABLE → QR / source / card identity can lead a referral back to the journey
```

Existing QR/join infrastructure should be extended rather than replaced.

The intended sequence is:

```text
true client outcome
    -> shareable milestone card
    -> QR / WhatsApp join
    -> attributable signup
```

Do not scale creators or Meta ads until the actual Coach experience is truthful and frictionless for ordinary users.

## Days-to-goal doctrine

Days-to-goal is an **estimate**, never a promise.

It belongs in the client journey only after sufficient evidence exists (for example, several weigh-ins across a meaningful time window). Do not create a third competing pace calculator. One owner should consume canonical progress truth and expose an estimate only when the evidence supports it.

## Scope discipline

Do not launch another architectural rebuild because one edge case exists.

The foundation freezes when the core contract is stable:

```text
messy input
-> truthful state
-> correct time
-> correct request/constraint
-> one decision
-> one Coach
```

After that, normal product improvements continue inside the architecture. A new architectural review is justified only when real beta evidence demonstrates that the frozen authority model cannot represent a required user behaviour.

## Testing standard

For important coaching doctrines, verify the entire chain:

1. doctrine defined;
2. evidence calculated;
3. evidence stored/retrieved;
4. evidence injected into the actual live path;
5. model receives it when the model is genuinely used;
6. output is checked mechanically where possible;
7. live-model behaviour is explicitly labelled verified or unverified;
8. permanent regression coverage captures the learned failure.

Do not use repeated reviewer cycles as a substitute for implementation. Reviews are guardrails at defined gates; they are not the product-development loop.

## Core failure patterns already discovered

The repository history contains real examples of failures that must not return:
- UTC vs SAST day-boundary contradictions.
- `pre-workout` interpreted as a supplement instead of a time context.
- portion phrases such as "2 spoons of pap" inflated into multiple full portions.
- estimated calories presented as database-verified without provenance.
- adaptive target changes made when intake evidence was insufficient or clearly above target.
- "weakest lever" / argmin-style fields steering the coach toward a change when no material problem existed.
- Law 26 hunger reasoning being stated in the prompt without the required evidence actually arriving in the model input.
- a meal-slot word such as "breakfast" being fuzzy-matched to a branded meal that the client never ate.
- explicit training refusal being routed into today's workout renderer.
- a correction for yesterday silently amending today's meal.
- coach criticism being answered by an unrelated scale/workout action.
- client statements such as "done eating badly" being confused with "done eating."
- production build failure caused by Railpack secret resolution; the production path now uses the repository Dockerfile rather than Railpack inference.

Treat these as regression knowledge, not historical trivia.

## Product success test

The core journeys must become exceptionally reliable:
- messy multi-meal voice dump;
- multiple days reported in one message;
- late / corrected / backdated logging;
- sparse logging with a usable weight trend;
- flat trend with insufficient food evidence;
- apparent stall with intake clearly above target;
- one-off alcohol/social event without overreaction;
- repeated weekend pattern with enough evidence to act;
- two-week absence and clean re-entry;
- client who says they cannot train for several days receiving a sensible bridge plan rather than a workout dump;
- client who reports a social weekend receiving context-appropriate coaching rather than a generic compliance lecture;
- medication/GLP-1 context with safe boundaries;
- a genuinely on-track client receiving the correct advice: **change nothing**.

## Builder instruction

When a task conflicts with this contract, stop and surface the conflict before implementing it. Prefer the smallest change that strengthens the decision loop and preserves existing architecture. Do not add features merely because competitors have them. Ask:

**"Does this change what we would tell this person to do next?"**

Also ask:

**"Does this work for the imperfect client who reports three days late in one voice note?"**

If either answer is no, reconsider the design.
