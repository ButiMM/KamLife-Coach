# CTO Coach-Loop Audit — 24 Aug 2026

## Current base

`60af55b` — continuity slice.

This branch is a controlled primary-builder continuation from that base. No new decision engine, memory service, embeddings, or Pulse rebuild.

## Product contract

```text
messy human input
→ truthful state
→ correct time window
→ relevant recent context
→ latest explicit constraint
→ one existing decision
→ one Coach response
```

## Confirmed structural findings from code

### 1. Morning had two customer-facing clocks

`server/scheduler/shared.ts` already computes `workout.sessionsThisWeek` from `sastWeekStart()` and exposes it on `ProactiveState`.

`server/scheduler/jobs/morning.ts` also separately computes a 28-day workout count and trajectory (`completedSessions28`, `sessionCompliance28`, `trajectory`) and passes that into `morningClosingLine()`.

`server/morning-message.ts` previously exposed that 28-day score directly to the client as:

- `N sessions in the last 4 weeks`
- `Today is a fresh page`

This was a duplicate customer-facing progress authority.

### 2. `chooseAction` is still the canonical action owner

`server/one-action.ts` remains the behavioural decision owner. It receives `sessionsThisWeek`, `foodDayClosed`, schedule-adjusted `sessionsTarget`, and produces one `OneAction`.

The primary-builder branch has not created another decision owner.

### 3. Morning status can still contain instruction-shaped text

`composeMorning()` receives `todayLines` separately from `decisionLine`. The old code deliberately exempted `todayLines` from the recognition filter. That allowed text such as `Reply 1 for your workout` and `stay on food and steps` to compete with the canonical decision.

The primary-builder branch now runs `todayLines` through the same `recognitionOnly` filter so the canonical `decisionLine` remains the only behavioural instruction in the morning composer.

### 4. Day-relative situation has a real parsing edge

`server/memory.ts` currently derives a broad situation from recent messages using `extractSalientSituation()`, then derives time separately using `situationWhen()`.

The situation detector treats `today`, `tonight`, and `this weekend` as positive `todayish` signals. A single natural client message can contain both a completed weekend event and the word `today`, for example:

> `The birthday weekend was hectic, so we're thinking about skipping today.`

That can promote a completed birthday weekend into the current-day celebration frame.

This is the next continuity defect to trace and close. It should be solved by better day-relative evidence in the existing situation owner, not by adding a new memory system.

### 5. Exact current-date grounding is not a Coach capability

The live phone case `What day is it today?` currently reaches a non-date fallback. The system has `todaySAST()` / SAST utilities, but there is no clear deterministic front-door owner for this basic calendar question.

This is a small grounding capability, not a new AI system. It should be answered directly from the existing SAST clock.

### 6. Natural correction is still too command-shaped

Live example:

> `You missed the black coffee`

was treated like a request to provide a missing meal instead of a correction to the existing breakfast.

The product contract requires conversational correction/update semantics: the client should not have to restate a whole meal because one component was omitted.

This needs tracing through existing food correction / food-log management before adding a new parser.

### 7. Short follow-ups are not consistently anchored to the active turn

Live example:

> `And the steps?`

received the previous situation frame and protein decision instead of answering the step question.

The next investigation should trace which handler claims two-to-five-word follow-up questions, whether the current topic/turn state is preserved, and whether the existing step owner can answer from authoritative today-state before GPT.

## Primary-builder work already committed on branch

### `f2ef22a` — morning authority cleanup

Removed the client-facing 28-day trajectory score from `morningClosingLine()`.

Re-entry recognition survives only when the client is actually non-engaged. Engaged clients no longer receive lapse framing.

### `62ff4f8` — dedicated Coach-loop foundation suite

Added `script/coach-loop-foundation-tests.ts` covering:

- no 28-day client-facing trajectory score;
- no fresh-page shame for an engaged client;
- `todayLines` cannot emit `Reply 1` while the canonical decision is present;
- the canonical decision remains present.

### `033afc2` — suite chain includes the new proof

`run-suites.ts` now runs `coach-loop-foundation-tests` alongside the existing suites.

## Next implementation order

1. Day-relative situation: distinguish completed weekend/last-night events from events actually happening today.
2. Natural follow-up ownership: a short question such as `And the steps?` must use the current topic and the authoritative step state before generic GPT.
3. Conversational correction: `You missed the coffee` must update the existing breakfast rather than ask the client to restate a meal.
4. Deterministic current-date answer: `What day is it today?` uses the SAST clock directly.
5. Re-run the existing production-parity and Coach-loop suite; add negative controls for each structural change.

## Hard boundaries

Do not:

- create Pulse 2;
- create another decision service;
- turn embeddings on;
- add a memory service;
- create a new specialist mouth;
- solve the phone transcript with phrase-by-phrase patches;
- begin milestone/QR/creator/Meta implementation on this branch.

Those are either already closed, are downstream Track 2 work, or violate the one-owner architecture.

## Handoff to Claude

Claude should inherit this branch as the primary-builder continuation and review the root-cause map before writing further code. Existing changes are intentionally small and isolated so they can be reverted independently if the review finds a better implementation boundary.
