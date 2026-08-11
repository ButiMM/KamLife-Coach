# KamLife Coach — Backlog

Findings recorded deliberately, to be adjudicated on their own merits rather than
folded into an unrelated work order. Nothing here is authorized for change.

---

## PRIV-1 — Client message content is written to the application log stream

**Recorded:** 2026-08-11, during WO7 acceptance (the privacy grep).
**Status:** OPEN — recorded, not adjudicated. No fix authorized.
**Not a WO7 defect.** WO7 removed the three temporary probes added during WO4–WO6.
Everything below predates this session and was found by the grep WO7 asked for.

### Why this matters

WhatsApp message bodies are client personal information. What a member eats, what
they weigh, and what they are struggling with is health-adjacent data. These lines
copy that content into stdout, which Railway captures and retains under its own
policy — a destination the POPIA consent flow never named. Deleting a member's
account does not reach it.

### Ordinary-traffic lines (highest volume, unambiguous)

| Location | Emits | Fires on |
|---|---|---|
| `server/routes.ts:690` | `[NORMALIZER]` — 80 chars of the member's message **and** the rewrite | Every normalized turn |
| `server/routes.ts:1054` | `[MULTI_INTENT]` — 70 chars of the message | Every multi-intent turn |
| `server/handlers/food-context.ts:1439` | `[GPT-FOOD-FALLBACK]` — 60 chars, on the **feeling-clause** path | Turns carrying emotional content |
| `server/handlers/food-context.ts:1441` | `[GPT-FOOD-FALLBACK]` — 80 chars | Unreadable food descriptions |
| `server/handlers/media.ts:510` | `[ALBUM_FOOD]` — 100 chars of the vision reply describing a member's food photo | Photo meal logs |

These five are the straightforward part. The content is not needed to operate the
product; the routing decision is, and that is already logged separately without it.

### Safety paths — a decision, not a bug

| Location | Emits | Fires on |
|---|---|---|
| `server/handlers/safety.ts:131` | `[CRISIS]` — member **name, phone, and 150 chars** of a crisis message | `COACH_ALERT_PHONE` unconfigured |
| `server/handlers/safety.ts:163` | `[ACUTE_MEDICAL]` — same shape | `COACH_ALERT_PHONE` unconfigured |

The most sensitive text in the product, and the trade may well be correct: these
fire **only** when the coach alert phone is not configured, so the line is the last
remaining record that a person in crisis was not escalated to a human. Removing it
to satisfy a privacy sweep would delete the audit trail of a life-safety failure.

**Adjudicate deliberately.** The likely right answer is neither "keep" nor "delete"
but "make `COACH_ALERT_PHONE` a boot-time requirement so this branch cannot fire" —
which changes the problem instead of the log line.

### Lower concern — our own outbound prose, not the member's words

`server/scheduler/shared.ts:518` and `:548`, and `server/routes/admin.ts:443`, log
message bodies **we** wrote, plus the last 8 digits of a phone number. Different
class. Listed for completeness so a future sweep does not rediscover them as new.

### Clean, verified

`server/index.ts:650` is the log formatter itself. `server/understanding/sa-transcript.ts:120`
logs a character count only. `[FOOD_GATE]` and `[FOOD_SCAN]` in `food-context.ts`
carry gate booleans and a word count — no content, confirmed by WO7.

### Suggested shape when this is picked up

One redaction helper with a single owner, so "may a member's words reach a log?" has
one answer in one place rather than a per-call-site judgement. The volume lines lose
the content and keep the decision; the safety lines get their own explicit ruling.
Not started, not designed, not authorized.
