# ADR: Keyword-presence routing → intent lanes

**Status:** accepted — Stage 1 shipped 2026-07-14. Stages 2–3 gated behind the
stabilization contract (docs/stabilization-contract.md).

## The problem (in the founder's words)

> "You mention food in the sentence, and it brings up other nonsense. You mention
> workout... flu... other nonsense. These are comprehensive deep rooted problems in
> our foundational systems."

The root cause has a name: **keyword-presence routing**. The pipeline has 50+
deterministic handlers, most gated by a regex that checks whether a trigger word is
*present* in the message. But presence is not intent:

- "The flu is going around **at work**" → sick template fired, check-ins paused
- "I'm **sick of pap** every day" → sick template (idiom, not illness)
- "**Flu shot** tomorrow, can I still train?" → sick template (prevention, not illness)
- "Ate so much at the party, I **feel sick**" → sick template (regret, not illness)
- "I had chicken and rice after my **workout**" → risk of a session dump instead of a food log

Whichever handler's keyword appears *earliest in the pipeline* eats the message.
Pipeline order — a build-time accident — decides meaning. That is why fixing one
screenshot kept creating the next one: every patch moved the collision, it never
removed the class.

## The decision: intent lanes, staged

A message gets assigned to ONE lane (sickness-report, food-log, workout-request,
question, plan/schedule, …) and only that lane's handlers may respond. Presence of a
word from another lane is context, not a route. Rolled out in three stages so the
live product never regresses:

### Stage 1 — precision gates + the measuring instrument (SHIPPED)

Every keyword gate gets the four questions a lane router would ask, encoded as cheap
deterministic guards, starting with the worst offender (sick flow,
`server/handlers/sick-flow.ts`):

1. **Who is the subject?** Third-person sickness ("my sister is sick", "flu going
   around at work") never fires unless a first-person assertion backs it up.
2. **Is it even the concept?** Idioms ("sick of pap", "sick and tired of") and
   prevention ("flu shot") are scrubbed before the gate; overeating/exertion
   "feel sick" is regret, not illness, unless a hard illness word (fever, vomiting,
   food poisoning…) is present.
3. **Report or question?** A question that isn't a comeback question never gets a
   template — it falls through to the brain, which carries the sick-state snapshot
   and answers the *actual* question. Exception: a fresh first-person report phrased
   as a question ("I'm sick, can I train?") — the template genuinely answers it.
4. **Does answering lose the report?** A message that declares AND asks ("I can't
   walk today, I'm sick. How does that affect my progress? …next 5 days") records
   `sick_until`/`paused_until` first, then answers.

The measuring instrument is the **CROSS-INTENT BATTERY** in
`script/routing-audit.ts`: real messages where an intent word appears in a context
that intent must not own, run through the real `handleMessage` pipeline offline.
Every new tester screenshot in this class gets a case there within 24h (freeze
rule) — the battery is how we know the disease is shrinking instead of moving.

### Stage 2 — lane assignment for loggers and templates (NEXT)

`classifyIntent` (the Normalizer, already fired in the background on every message)
returns a verdict; bind the high-risk handlers to it: a logger (food, steps, water,
weight, lift) may only take a WRITE side effect when the classifier verdict agrees
it's a report, with the existing deterministic detectors as the offline/timeout
fallback (never a hard dependency — the classifier can be down). QUESTION verdicts
already guard the step logger; extend to all loggers and all templates.

### Stage 3 — full lane router

One routing decision at the top of the pipeline assigns the lane; handlers register
per-lane instead of running in a fixed global order. Pipeline order stops being
load-bearing. Only after Stage 2 has run clean in production — the battery and the
nightly drill battery are the gate.

## What we explicitly did NOT do

- **No LLM in the deterministic path.** Stage 1 is pure regex-with-context — it runs
  offline, costs nothing, and cannot time out. The brain stays the last resort.
- **No rewrite.** The pipeline order is unchanged; each gate just got smarter about
  what it refuses. Every change shipped with its regression case in the same commit.

## Consequences

- A missed sickness report (false negative) now falls to the brain, which carries
  the sick-state snapshot and a health-event playbook — degraded, not silent.
- Third-person sickness gets a normal conversational reply instead of pausing the
  member's own check-ins for 3 days.
- The battery is append-only: removing a case requires the same justification as
  deleting a production guardrail.
