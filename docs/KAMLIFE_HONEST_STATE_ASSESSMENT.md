# KamLife Coach — Honest State Assessment

*Prepared for independent third-party review. Written to be read by someone who has
never seen this codebase and needs to form their own opinion of where it stands.*

**Date:** 21 July 2026
**Product:** KamLife Coach — a WhatsApp-based AI fitness & nutrition coach for the South
African mass market. R199/month. Days from public launch and a Meta/WhatsApp Business
submission.
**Stack:** TypeScript / Node / Express on Railway · PostgreSQL + Drizzle ORM · Twilio
WhatsApp · OpenAI (gpt-4o / gpt-4o-mini) · PayFast billing.

> This document is deliberately blunt about failures. The founder asked for an honest
> account, not a sales sheet. Read the "What Works" and "What It Cannot Do" sections
> together — the truth is that the system is *capable but narrow, and fragile in a
> specific, diagnosable way*, not that it is worthless.

---

## 1. What the product is supposed to be

A single WhatsApp number that behaves like a real South African coach — warm, direct,
speaks the language, knows the food, the budgets, the townships, the medical realities —
and coaches ordinary people (domestic workers, students, the unemployed, diabetics,
gogos, taxi commuters) to change their health with very little money and no app to
download. Everything happens in a WhatsApp chat: you send a photo of your plate, a voice
note, "I did 6000 steps," and the coach responds.

The ambition is genuinely broad: the *target market* is the SA mass market and its whole
range of health needs. **The product as built is much narrower than that ambition.** That
gap is the central finding of this document.

---

## 2. What we have actually built (capability inventory)

This is a large, real system. The following all exist and function:

### Conversation & intelligence
- **A "meaning engine" / Coach K brain** — the conversational core. An LLM given a large
  hand-written system prompt (Coach K's persona, voice, SA knowledge, medical playbooks,
  myth-busting, budget coaching) plus a per-client "snapshot" of real data.
- **The Inversion** — the brain now runs as the *front door* for genuine conversation;
  deterministic handlers own exact commands, logging, safety, and billing.
- **A reply verifier** — a deterministic self-correcting check that blocks the brain from
  shipping fitness myths, false action-claims ("I'll change your targets"), goal
  contradictions, and (as of today) off-programme exercise freelancing.
- **A sanitizer** — deterministic word-net that strips banned bot phrases, capability
  lies ("I can't see photos"), and budget-mismatched food suggestions from every reply.
- **A domain guard** — keeps the coach on health topics, warmly redirects off-topic.
- **A normalizer** — rewrites messy phrasing into canonical commands before routing.

### Data capture & logging
- **Food logging** by text, photo (vision), and voice note → calories + protein, running
  daily totals, meal labels, per-client portion learning and meal-slot learning.
- **Workout logging**, steps, water, body weight — each with SA-phrasing tolerance.
- **Progress photos** → a physique read (lagging vs dominant muscle groups) and a
  month-over-month progress comparison.

### Coaching outputs
- **Programmes** — deterministic beginner/intermediate/advanced machine-based plans,
  delivered day-by-day with form cues and demo media.
- **Meal plans, shopping lists, food swaps** — budget-tiered (R57/R100/R200… baskets).
- **Restaurant & street-food guidance**, menu-photo reading, portion images.
- **Physique-aware coaching** — targets a client's lagging body parts.
- **Reminders with temporal memory** — "doctor says I go back Monday" is anchored to a
  real date and nudged the night before.

### Operations & safety
- **Onboarding** — goal, weight/height (typed or photo-estimated), medical conditions,
  body photos, computed targets; BMI/reality gates that steer an obviously-wrong goal.
- **Proactive scheduler** — weekly recaps, Monday weigh-in ritual, week-3/6/9 nudges,
  month-end budget mode, business/billing jobs. Global killswitch (`PROACTIVE_PAUSED`).
- **Billing** — PayFast R199/month, SMS fallback for critical payment alerts.
- **Crash-safety** — media jobs persisted in Postgres and swept, so a restart mid-photo
  doesn't drop a client's message.
- **A 12-script test suite** (unit, integration, food-scanner, safety-audit,
  golden-regression, routing-audit, gap-tests, onboarding-e2e, video-path, a real-world
  "phrasing battery," file-size and pricing guards) run before every push; CI on PRs +
  nightly.
- **Coach diagnostic commands** — text the live bot `replay`, `scorecard`, `action
  replay`, and now `version` (reports the running commit + a live self-test).

**Assessment:** the *breadth of knowledge and machinery* here is substantial and, in
places, genuinely sophisticated (the verifier + sanitizer + snapshot pattern is a sound
way to keep an LLM honest). This is not a thin wrapper around ChatGPT.

---

## 3. What the system cannot do (the honest gaps)

### 3.1 It serves only ONE kind of person: someone chasing a body

This is the biggest gap and it is structural, not cosmetic.

**The entire product supports exactly three goals: `fat_loss`, `muscle_gain`,
`recomposition`.** Every person who signs up is funnelled into one of those three, and all
three are about body shape. There is **no goal, anywhere in the system**, for:

| The person | What they actually want | What the product gives them today |
|---|---|---|
| Diabetic / pre-diabetic (an epidemic in SA) | stable blood sugar, a daily walk, meds timing, low-GI eating | a fat-loss calorie budget + a high protein target |
| Hypertensive | lower BP, less salt, gentle movement | a body-composition programme |
| "I'm just tired — I want energy / to sleep" | sleep, stress relief, steady meals | a calorie deficit + a step quota |
| Older adult (55/60+) | strength, mobility, independence, managing sugar/BP | machine-physique targets + macros |
| Event-driven (wedding, function) | a time-boxed plan | an open-ended body-comp loop |
| The person who refuses numbers | plain words, encouragement | numbers pushed at them |

The AI brain *knows* how to coach a diabetic or a gogo — that clinical knowledge is in the
prompt in detail. But the **product spine** (goal → targets → daily loop → what it
celebrates → what it nudges) assumes a physique goal and forces it on everyone. A diabetic
grandmother is handed a 185g protein target. **This is the mismatch between the product and
its stated mass-market ambition, and it is the #1 thing an outside reviewer should weigh.**

### 3.2 The goal concept is duplicated across ~50 files (fragility by design)

`goalType` and the literal strings `fat_loss` / `muscle_gain` / `recomposition` appear in
**~50 source files, hundreds of times** — targets, onboarding, the daily loop, food,
workouts, the proactive scheduler, weekly recap, meal plans, and more. There is no single
source of truth for "what does this goal mean and how should the product behave."

Consequences:
- **Adding a new goal is a 50-file change.** Miss one site and you get a *half-built*
  feature: captured at signup, ignored downstream. (This has already happened — an
  onboarding path records a `health_condition`/`general` goal that the rest of the system
  never acts on.)
- The same class of bug reappears in new phrasings because fixes are local to one file.

### 3.3 Development has been reactive, not architected

For six months the dominant loop has been: a live screenshot reveals a bad reply → a
targeted fix for *that* phrasing → repeat. This is whack-a-mole. It has produced a system
that is broad but brittle: many individually-patched behaviours, no unifying model of the
user. The founder's recurring, correct complaint — "you fix one thing and three others
break, no matter how many reviews we run" — is a symptom of this pattern, not bad luck.

### 3.4 "Prompt-hoping" vs. enforced behaviour

Much desired behaviour lived only as instructions in the system prompt — which the model
can and does ignore. Example found *today*: the prompt clearly forbade inventing exercises,
yet the live bot told a client to "incorporate exercises like rows and planks… squats and
lunges," none of which are in the fixed programme. The fix was to move the rule into a
deterministic verifier (code), not to add another prompt line. **A meaningful fraction of
the product's "rules" are still prompt-only and therefore not guaranteed.**

### 3.5 Deploy invisibility (a trust failure, now partly mitigated)

The founder is non-technical and cannot see whether a pushed fix is actually running on the
live bot. For months this turned every "it's fixed" into "nothing works," because there was
no way to distinguish *not fixed* from *fixed-but-not-deployed*. Mitigated today with a
`version` command that makes the live bot report its running commit and self-test — but the
underlying issue (no founder-facing deploy/observability) was long unaddressed.

### 3.6 Model-quality failures are under-tested

The 12-script suite is excellent at **routing** (where a message goes) because those are
pure functions. It does **not** test what the *model actually says* on a live call — that
needs a drill harness against the real model (an OpenAI key in CI), which is not yet wired.
So model-level regressions (vagueness, generic answers, tone) are caught by the founder in
production, not by the suite.

### 3.7 Smaller, known, still-open defects
- **Food log has no clear bottom line.** A meal reply should end with "today's total /
  target / how much is left," in plain language that teaches even the no-numbers user. It
  doesn't, consistently.
- **Coaching can still be vague** — naming a muscle ("your back and core") instead of the
  actual machine ("your lat pulldown"). Partially addressed today.
- **Triple-acknowledgement** on progress-photo albums (each photo acks separately).
- **Voice-note handling** for long rambles depends on a condense step that can misfire.

---

## 4. Root-cause assessment (my actual opinion)

The founder asked for a point of view, so here it is, plainly:

**The product was conceived as a body-composition tracker and given a superb coach's
voice — then extended reactively, one failure at a time, without ever installing a model
of "who is this person and what do they need."** The result is a system with:

1. **A wide, capable brain** (knows medicine, budgets, SA life, myths) —
2. **speaking through a narrow, rigid spine** (three body-shape goals, macro-centric
   targets, a physique-shaped daily loop) —
3. **built on duplicated concepts** (the goal is re-encoded in ~50 places) —
4. **enforced by hope in places it should be enforced by code.**

None of these four is fatal, and none requires a rewrite. But together they explain the
lived experience: the coach *sounds* right, occasionally does something clearly wrong, and
never quite fits the person it's talking to — because the person was flattened into a
fat-loss client at signup.

**The fragility is not caused by a lack of features or a lack of reviews.** It is caused by
(a) the missing central model of the user and their goal, and (b) a development style that
patched symptoms instead of installing that model. More reports will not fix it; a
structural change will.

---

## 5. What I would do, in order (for the reviewer to challenge)

1. **Centralise the goal.** One `GOAL_PROFILE` source of truth — `{ label, usesMacros,
   dailyWin, framing, tracks }` — that the ~50 scattered checks read from. New goals become
   safe by construction (they can't hit a broken branch).
2. **Widen the goals** to health-led and life-led: *manage a condition · more energy ·
   stay strong & independent · an event*. Targets, the daily loop, and the "wins" adapt to
   the profile, so a diabetic is coached on sugar and a walk, not a protein quota.
3. **Deepen per segment** — diabetes/hypertension get their real loop (readings, meds
   timing, low-GI), surfacing the clinical knowledge the brain already holds.
4. **Move remaining prompt-only rules into deterministic guards** on every reply path
   (the verifier now runs on the front-door engine; extend its coverage).
5. **Wire a live model-drill into CI** so tone/vagueness regressions are caught before the
   founder sees them.
6. **Stop shipping by screenshot.** Batch fixes by class, each with a permanent test.

Every one of these should be built as a *complete vertical* (signup → stored → targets →
loop → wins → coach framing), shipped, and verified on the live bot — never captured-but-
ignored.

---

## 6. Questions for the third-party reviewer

- Is widening to health/condition-led coaching the right strategic move before launch, or
  should the product launch narrow (body-comp only) and expand after revenue?
- Given the SA disease burden, is diabetes/hypertension management the highest-value first
  segment — and does coaching it responsibly raise medical-liability questions that change
  the scope?
- Is the "capable brain, narrow spine" diagnosis correct, or is the real risk elsewhere
  (retention, unit economics, WhatsApp/Meta policy, model cost at scale)?
- Is the reactive, screenshot-driven development history a process problem that will
  recur, and what would you change about how work is planned?

---

*End of assessment. This document reflects the state of the system as of 21 July 2026 and
is intentionally candid. It should be read alongside the codebase, not in place of it.*
