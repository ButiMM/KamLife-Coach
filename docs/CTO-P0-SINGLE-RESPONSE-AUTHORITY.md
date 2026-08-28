# P0 — SINGLE RESPONSE AUTHORITY

## Why this exists

A live WhatsApp turn on 28 Aug 2026 produced a correct policy statement and then contradicted it in the same response:

- `I'm not going to call a trend...`
- `Scale is going up — keep fuelling.`

This is not another evidence-policy problem. It demonstrates that customer-facing coaching text can still be authored after the canonical decision by another path.

The same live turn also produced conflicting session identity, showing the broader risk is turn composition / authority, not one bad weight phrase.

## Mission

Trace the actual WhatsApp production path on `main` and identify every function that can author customer-facing coaching text **after the canonical decision**.

Do not start by proposing a rewrite. Do not patch individual phrases.

## Required artifact

Complete `docs/CTO-TURN-AUTHORITY.md` from the live code and a production-shaped replay of the trend case.

For each stage, record:

| Stage | Function / file:line | May write DB? | May write customer-facing reply? | Called on target turn? |
|---|---|---:|---:|---|
| inbound | | | | |
| parse / understand | | | | |
| state read | | | | |
| state write | | | | |
| evidence | | | | |
| canonical decision | | | | |
| action select | | | | |
| text compose | | | | |
| send | | | | |

## Target evidence

Trace the origin of both sentences in the same turn:

- `I'm not going to call a trend...`
- `Scale is going up — keep fuelling.`

The answer must come from code and runtime, not comments or architecture docs.

## Acceptance

The trace is complete when we can name the one authoritative customer-facing composer for the turn and identify every post-decision writer outside it.

Only then create the next implementation PR. That PR must be minimal and target the ownership defect exposed by this trace.

## Explicitly out of scope

- Do not fix meal recommendation dose.
- Do not fix session copy.
- Do not fix re-entry.
- Do not add new evidence theory.
- Do not change the constitution.
- Do not create a new router or model.

Those may become later cuts. This P0 is only about who is allowed to author the final customer-facing response.
