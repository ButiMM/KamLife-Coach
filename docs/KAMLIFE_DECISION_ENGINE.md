# KamLife Decision Engine

## Product contract

KamLife is not primarily a calorie tracker, content engine, or general-purpose AI assistant. It is a coaching decision engine that turns imperfect real-life information into the least intervention justified by the evidence.

**Core loop**

```text
real life input
  -> preserve reality
  -> establish what is known
  -> establish what is uncertain
  -> decide what matters
  -> choose the least intervention justified
  -> act
  -> observe outcome
  -> adapt
```

## Permanent principles

1. **Information is not the product. Decisions are.**
2. **Weight trend is the outcome signal; food and behaviour logs are explanatory evidence.** A single scale reading is not a verdict.
3. **Missing data is not proof of behaviour.** Before interpreting a gap, determine whether it is mechanical, situational, or behavioural.
4. **Preserve client truth.** Never invent what the person said, ate, trained, felt, or experienced.
5. **Evidence before intervention.** Do not manufacture certainty because the model is expected to answer.
6. **The least intervention justified by evidence wins.** The correct action may be no change.
7. **CONTINUE, CHANGE, INVESTIGATE, and REFER/ESCALATE are all valid outcomes.**
8. **"I don't know yet" is a successful coaching outcome when evidence is insufficient.**
9. **Only collect information that could change the next instruction.**
10. **Re-entry has no shame and no forced historical backfill.**
11. **Daily value does not require daily intervention.** Observation, reassurance, accountability, and recognition are valid daily value.
12. **Meaningful plan changes are evidence-gated.** Do not constantly tweak targets to manufacture novelty.
13. **Teach just in time.** Education should appear when the client is facing the relevant decision.
14. **Health and medication context is a safety layer, not a growth feature.** KamLife must never dose, titrate, source, or substitute prescription medication.
15. **The customer should never have to understand the database or internal architecture to use KamLife.**

## Competitive positioning

South African WhatsApp + food logging + dashboard + local-food coverage are table stakes. KamLife must not claim these as its primary moat.

The intended distinction is:

```text
Tracker model:
food -> calories -> target -> dashboard -> nudge

KamLife:
life -> events -> evidence -> uncertainty -> decision -> action -> outcome -> adaptation
```

The product must earn the premium through better longitudinal decisions, not feature count.

## Decision hierarchy

Every coaching turn should implicitly answer:

- What do I know?
- How trustworthy is it?
- What is the client trying to achieve?
- Is there a meaningful problem?
- Is there enough evidence to act?
- If not, what is the minimum useful fact that could change the next action?
- If yes, what is the single highest-leverage next action?
- Is the situation outside KamLife's safe scope?

## Core journeys that must be excellent

- Messy multi-meal voice dump.
- Late/backdated logging and chronology correction.
- Partial logging without treating the user as non-compliant.
- Weight trend moving appropriately: **CONTINUE / no unnecessary change**.
- Weight trend not responding with insufficient intake evidence: **INVESTIGATE**.
- Clear adherence problem with enough evidence: **CHANGE one lever**.
- Two-week or longer disappearance: **re-entry without shame or backfill**.
- Alcohol/social event: contextualise the week; do not moralise from one event.
- Structural constraint: shift work, affordability, family meals, gym access, transport, time.
- Medication/GLP-1 context: constrained coaching and safe escalation.
- Medical/safety concern: deterministic boundary and referral/escalation rather than free-form model judgment.

## Engineering acceptance standard

A capability is not considered shipped because it is present in a prompt or source file.

For a material coaching doctrine, engineering must be able to identify:

1. the doctrine;
2. the evidence it requires;
3. where that evidence is computed;
4. where it is stored or reconstructed;
5. which live paths receive it;
6. deterministic tests that prove delivery;
7. behavioural tests that prove the model used it when applicable;
8. production evidence before calling the behaviour validated.

Keep **implemented**, **deterministically verified**, and **behaviourally verified** as distinct states.

## Data minimisation gate

Before adding a field, event, question, integration, or memory category ask:

> **Would knowing this change what KamLife tells this person to do next?**

If not, do not collect it merely because it is technically available.

## Change discipline

Do not add novelty merely to create daily activity. The most common correct coaching decision may be to continue the current plan for days or weeks. Product metrics must not reward unnecessary intervention.
