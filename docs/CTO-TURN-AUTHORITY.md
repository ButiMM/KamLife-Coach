# CTO TURN AUTHORITY TRACE

## Mission

Determine, from the live `main` WhatsApp path, exactly which functions are allowed to author customer-facing coaching text after the canonical decision.

This is **not** a new architecture proposal and not a symptom-fix list. It is a finite trace required because a live turn on 28 Aug 2026 produced both:

1. a correct hold: illness-adjacent weigh-ins were judged insufficient to call a trend; and
2. contradictory follow-on coaching: `Scale is going up — keep fuelling.`

The product therefore demonstrated that the final customer-facing response can still contain more than the canonical decision.

## Acceptance condition

For the real WhatsApp path represented by the 16:49 trend turn:

`inbound -> understanding/truth -> evidence -> canonical decision -> action -> final composition -> send`

must have one authoritative customer-facing composer after the canonical decision.

No downstream function may append, prepend, rewrite, or otherwise author a second coaching action outside that authority.

## Trace table

| Stage | Function / file:line | May write DB? | May write customer-facing reply? | Called on the target turn? | Evidence |
|---|---|---:|---:|---:|---|
| inbound | TBD | | | | |
| parse / understand | TBD | | | | |
| state read | TBD | | | | |
| state write | TBD | | | | |
| evidence | TBD | | | | |
| canonical decision | TBD | | | | |
| action select | TBD | | | | |
| text compose | TBD | | | | |
| send | TBD | | | | |

## Required trace

Trace one production-shaped trend question after an illness-adjacent weigh-in, using the same WhatsApp entry path that served the live screenshot.

Record every function that can produce or modify user-visible text between the canonical decision and the final send.

In particular locate the origin of:

- `I'm not going to call a trend...`
- `Scale is going up — keep fuelling.`

Do not infer the owner from comments or the roadmap. The running code and one replay decide it.

## Important current observation

`server/understanding/live.ts` already declares a canonical decision boundary: `canonicalDecision()` calls `chooseAction()` / `underPolicy()`, renders the deterministic decision reply, and records `canonicalKind`, `canonicalTodo`, and `canonicalReply` as turn evidence. That is evidence of an intended boundary, not proof that no later writer exists.

## Stop condition

This document is complete when the target turn has a single named final-text authority and every later customer-facing write is either that authority or a non-coaching transport operation.

Do **not** fix the target bug in this trace document. The next code change must be a separate, minimal PR derived from the trace.
