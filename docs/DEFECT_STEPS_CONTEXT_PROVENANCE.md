# Step-context provenance defect

## Known production failure

On 12 August 2026, a real voice turn containing only:

> "I've just had another cup of coffee, black coffee"

received a coaching reply that additionally claimed the client had walked roughly 12,000 steps.

Production evidence established:

- ElevenLabs Scribe transcript was correct.
- Normalization changed the meal wording but did not introduce a step count.
- The client snapshot supplied a `Steps TODAY so far: 12,770` line.
- The Meaning Engine then had both the coffee statement and the step count available in context.
- The engine attempted `LOG_STEPS`, and the deterministic number gate correctly refused it because the number was not in the client's message.
- The reply nevertheless mentioned the step count.

## Current conclusion

This is a **state/context provenance defect**, not a transcription defect.

The current snapshot builder reads `stepLogs` and presents the maximum same-day value as the current day's progress. That is only safe if every `stepLogs` write is a trustworthy day-level client report/sync and its provenance is preserved.

The exact producer of the 12,770 row has not yet been proven from source/production evidence. Do not infer that it came from the `voice_ok total_ms=12770` timing metric without evidence.

## Acceptance gate

Before the step signal is allowed to influence coaching reasoning:

1. Every `stepLogs` write path is enumerated.
2. Every write identifies its source/provenance and intended SAST day.
3. The snapshot only presents a step value as current-day truth when that provenance is trustworthy.
4. A model cannot convert a context-only step value into a client-reported step log.
5. A context-only value may be mentioned only as observed state, never as something the client said or did in the current turn.
6. Regression covers the exact coffee + stale-step scenario.
