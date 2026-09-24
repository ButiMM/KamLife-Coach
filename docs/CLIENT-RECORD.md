# The client record: events and facts (#271, with #323)

ORDERS §4 Step 3. This document is the design, written **before** any code writes a row, because
the order says retention and verified erasure come first.

## What exists today, and why it is not enough

| Store | Holds | Problem |
|---|---|---|
| `turn_ledger` | input text, canonical (normalised) text, voice raw/cleaned, reply | Purged at 90 days (`admin-turns.ts`). Records *turns*, not what the client told us. |
| `chat_history` | message in/out | Receipts and drafts, not always what was said (AUDIT.md Trace 1). |
| `users` columns (`injuries`, `life_context`, `profile_notes`…) | six regex-extracted facts | ~194 writers, a free-text token store, no source, no time scope. The Comrades/knee statement lands in none of them (Trace 2). |
| `client_understanding` | engine memory | `keyFacts` rebuilt from the `users` row every turn (`store.ts:47-48`). |

## Two new tables

### `client_events` — what the client actually sent
One row per inbound message, written by the transport door (`processTextAsync`) with the body exactly as Twilio delivered it — the handlers and the normaliser never touch this copy. It is written *after* the turn, because a new client's first message is what creates their `users` row.

| column | meaning |
|---|---|
| `id` uuid | |
| `user_id` → `users.id` **ON DELETE CASCADE** | |
| `source_message_id` unique | Twilio MessageSid (idempotent on retries) |
| `received_at` | |
| `channel` | `text` \| `voice` \| `photo` \| `video` |
| `raw_text` | the body exactly as received, never rewritten |
| `transcript_raw` | voice: the transcription as returned, before any cleaning (column in place; filled when voice moves onto this record — today `turn_ledger.voice_transcript_raw` holds it) |
| `normalised_text` | what the pipeline acted on, if the normaliser changed it (column in place; filled by #323) |

**Immutable means protected from rewriting, not undeletable.** No code path updates `raw_text` or
`transcript_raw`; a database trigger rejects an `UPDATE` of either. `DELETE` is allowed, and is how
erasure and retention work.

### `client_facts` — what the client told us, typed and sourced
| column | meaning |
|---|---|
| `id` uuid | |
| `user_id` → `users.id` **ON DELETE CASCADE** | |
| `kind` | `goal` \| `injury` \| `constraint` \| `schedule` \| `preference` \| `life_event` |
| `subject` | short key, e.g. `knee`, `comrades marathon` |
| `statement` | the client's own words for it (the quoted span), so the fact outlives its event |
| `detail` jsonb | structured extras (date, side, severity…) |
| `source_event_id` → `client_events.id` **ON DELETE SET NULL** | provenance |
| `valid_from`, `valid_until` | time scope ("sore this week" vs "training for June") |
| `superseded_by` → `client_facts.id`, `superseded_at` | corrections supersede; nothing is overwritten |
| `extracted_by` | extractor + prompt version |
| `created_at` | |

**Not facts:** questions ("could my knee be the problem?"), quotes of other people ("my sister is
pregnant"), hypotheticals. The extractor must return nothing for them; the gate carries controls.

**Corrections supersede.** "Actually the race is in May" writes a new fact and sets the old one's
`superseded_by`. History is never silently changed; the read side takes the unsuperseded row.

**Existing ledgers stay the owners of their writes** (meals, weights, steps, workouts). Facts are
what the ledgers do not hold.

## Retention

| Data | Kept | Why |
|---|---|---|
| `client_events` | **12 months rolling**, then deleted by a daily job | Raw words are the most sensitive thing we hold. After a year the facts (with their quoted span) carry what coaching needs. |
| `client_facts` | life of the account | They are the memory. A superseded fact is kept 12 months after `superseded_at`, then deleted. |
| On an event's deletion | its facts keep `statement` and lose `source_event_id` (SET NULL) | Provenance degrades to "the client said: …" rather than vanishing. |

## Erasure (POPIA "delete my data", #269)

Both tables hang off `users.id` with `ON DELETE CASCADE`, so the confirmed deletion in
`safety.ts` (which deletes the `users` row, #307) erases them in the same transaction.
**Verified, not assumed:** `pg-popia-deletion-acceptance` gains a check that, after DELETE, zero
`client_events` and zero `client_facts` rows remain for that user id.

No backfill runs until the erasure check is green on `main`.

## How it is used (this PR's scope)

1. **Write events** at the transport door (`processTextAsync`), for every inbound message, never awaited by the reply.
2. **Extract facts** in the background after the turn (one small model call, JSON, typed), never
   blocking or changing the reply. On model failure, nothing is written: no guessed facts.
3. **Read facts** into the meaning engine's context: active, unsuperseded facts, each with its kind
   and the client's words. This is what makes the Comrades/knee case pass.

Done when: the gate's `comrades-knee-memory` case passes (the facts survive six unrelated turns)
and the deletion acceptance proves erasure.

## Retires (CTO design review, 24 Sep)
The record is the **one** place the new coach learns what a client told us. It replaces these
stores. From now on, no new code writes to them. The #272 **switch PR** deletes their reads and
writes, once the new composer reads the record instead:

| Store | Where |
|---|---|
| Six regex-extracted memory fields | `server/memory.ts` |
| `profile_notes` tokens | `users.profile_notes` (41 files touch it) |
| `client_understanding.lifeStory` | `server/understanding/{store,state,compiler,perception}.ts` |
| The CIP narrative | `server/scheduler/jobs/{cip-update,narrative}.ts`, `server/intelligence/profile.ts` |
| Portion memory | `server/portion-memory.ts` |
| Held constraints | `server/held-constraints.ts` |

**Interim, also deleted by the switch PR:**
- the hook that feeds facts into the old Meaning Engine (`live.ts`, `meaning-engine.ts`);
- the separate `recordAndLearn` model call. At the switch, fact extraction folds into #359's single
  understanding call.

Until then, the call costs about R0.002 per inbound message (typical case: ~600 input and ~40 output
tokens on gpt-4o-mini), and R0.008 at most (1,200 input and 400 output tokens). It is logged in
`gpt_costs` as `feature = 'client_record'`, so the real figure is one query away.
