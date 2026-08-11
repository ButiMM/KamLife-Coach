# P2-D Prerequisite — Measurement Gap Closure

**Status:** measurement only. No coaching code touched. Nothing under `server/` or `shared/`.
**Run:** `npx tsx script/p2-measure.ts`

---

## 0. CORRECTION — P2-C's headline finding was wrong

P2-C reported **"17% of everything Coach K sent was not a coaching reply at all"** and called it
the largest thing in the corpus. **That was wrong, and the error was mine.**

`🎤 Coach K is listening…` is not a broken output. It is the voice-note acknowledgement, followed
by `🎤 I heard: "<transcript>"`, then the real reply. Across the full 26,288-line export:

| | |
|---|---|
| listening placeholders | 343 |
| **followed by a real coach reply within 3 messages** | **341 (99.4%)** |
| voice notes sent by the member | 408 |
| **received a substantive reply** | **395 (97%)** |

I counted a working pipeline as noise. Two consequences, both bad: the infrastructure rate was
inflated, and **four voice-rich conversations were discarded as "unscoreable"** when they were in
fact among the densest coaching material in the corpus.

### A second bug underneath it

WhatsApp prefixes media lines with an invisible LTR mark (`U+200E`), so
`‎[2026/08/06, 18:47:53] KAM: ‎audio omitted` never matched the timestamp pattern and was silently
**appended to the previous message**. Every media turn in the corpus was being swallowed. Fixing
it moved member turns from 92 to 111 and revealed 16 voice-transcribed turns that had been invisible.

### A third, in the truncation detector

9 apparent truncations were really 3. `*Today's food log (4 meals):*` followed by the meal-card
image is working as designed — the detector was reading punctuation, not delivery.

### Corrected reliability numbers

| measure | P2-C claimed | actual |
|---|---|---|
| non-coaching artifacts | 19/109 = **17%** | **5/97 = 5%** |
| — listening placeholder | 14 | **0 — working feature** |
| — Twilio transport error | 4 | 4 |
| — build artifact | 1 | 1 |
| truncated replies | 3 | 3 (arrived at correctly this time) |
| C1 hands work back | 8/90 = 9% | 8/92 = 9% |
| C3 verbatim repeat | 2/90 = 2% | 2/92 = 2% |

**All 4 Twilio errors are sandbox reconnection** — the founder's test sandbox expires every 72
hours and he re-joins with `join bag-string`. That is a test-environment artifact, not a
production reliability defect. A real WhatsApp Business number does not do this.

**So genuine reliability defects in this corpus: 1 build artifact + 3 truncations = 4 of 97 (4%).**
Not 17%. The infrastructure story is much smaller than I reported, and the coaching story is
correspondingly the main event after all.

### What this invalidates

- The P2-C claim that infrastructure outranks coaching failures. **Withdrawn.**
- The 4 conversations scored `UNRESOLVED — infrastructure`. **Invalid** — they are scoreable.
- The 25-turn calibration sheet's turn indices, which were generated with the broken parser.
  **The sheet must be regenerated before any further scoring.**
- The 19-turn sample distributions are **provisional** pending re-selection from a correctly
  parsed corpus. The anchors themselves survive — they were judged on message text, which was
  read correctly, not on indices.

---

## 1. Reliability measurement available from the existing corpus

Deterministic, unbiased, all 97 coach turns:

| defect | count | rate | production-relevant? |
|---|---|---|---|
| Truncated reply (nothing follows the terminator) | 3 | 3% | **Yes** |
| Build artifact reaching the member (`🚀 Running build`) | 1 | 1% | **Yes** |
| Twilio sandbox reconnection | 4 | 4% | No — test environment only |
| Self-duplication inside one reply | 1 | 1% | **Yes** (hand-counted) |
| Voice pipeline failure (ack with no reply) | 2 / 343 | 0.6% | Yes, but rare |

**The one that matters most is not the rate, it is the causal chain.** The truncated
`"I've got smart, goal-aware orders for these spots:"` is what produced *"Read my entire
paragraph ❗️❗️❗️"* and the anchored Understanding-1 failure that followed. **A plumbing defect
manufactured a coaching defect.** That relationship — not the 4% — is the reliability finding.

## 2. The exact evidence gap for Accountability

**Accountability was UNRESOLVED in 12 of 19 scored turns — the largest hole in the measurement.**

The gap is precise: accountability asks *did the coach identify what actually needed correcting?*
Answering it requires knowing what the member's adherence state **was** at that moment — calories
against target so far, protein, whether the weigh-in happened, sessions completed against plan,
streak state. **A transcript cannot show this.** When Coach K says nothing about a gap, a
transcript cannot distinguish "there was no gap" from "there was a gap and it was missed."

That distinction is the entire dimension.

## 3. The exact evidence gap for voice / multi-part coaching

**Smaller than P2-C claimed, and now partly closed.** The product echoes every voice note back as
`🎤 I heard: "..."`, so **the member's spoken words are recoverable from the transcript**. After the
parser fix, 16 of 111 member turns (14%) in the corpus are voice-transcribed.

Two real gaps remain:

1. **Long transcripts are elided.** The echo truncates with `…` — *"It's feeling pretty good. Today
   is my last session. It's the Friday session. I've done …"*. The exact case that matters most —
   a two-minute update carrying food, water, steps, training and mood at once — is the case where
   the evidence is cut off. We can see that Coach K received it; we cannot see all of what it received.
2. **We see the transcript, never the audio.** Whether transcription was *accurate* is unmeasurable
   from an export. A coaching failure caused by a mis-transcription is indistinguishable from one
   caused by bad reasoning.

Also newly visible and worth noting: the recovered voice turns contain real South African
code-switching — *"So the Cheerios and the energy drink are not a meal? Come on, mos."* — which
is principle 11 material that was invisible before the fix.

## 4. Minimum additional instrumentation to close them

Smallest thing that works, in priority order:

1. **A Turn Ledger–backed corpus adapter** (~1 module, mirrors the existing WhatsApp adapter).
   `turn_ledger` already stores `input_text`, `reply`, `resolved_day`, `state_read`, `mutations`
   and `version` per turn. `state_read` **is** the accountability evidence — it is literally
   "the facts the turn actually read before deciding." This closes gap §2 outright and switches
   on the continuity provenance check that has been UNAVAILABLE since P2-A.
2. **Full voice transcripts, not the elided echo.** Either lengthen what `🎤 I heard:` prints, or
   read `input_text` from the ledger, which stores the transcript whole. **The ledger route
   requires no product change at all** and is therefore preferred.
3. **Regenerate the calibration sheet** from the corrected parser, and re-score. Required before
   any further sample-layer claim.
4. **A hand-counted C1 rate** over all 92 coaching turns, or a better detector. The current 9% is
   a floor from a predicate that misses "What meal are you planning to have with those ciders?".

Not needed: no new handlers, no prompt changes, no model scoring, no governor movement.

## 5. Can the Turn Ledger provide this without touching real client records?

**Yes — and the distinction matters.**

`turn_ledger` rows are keyed by `user_id`. Reading **the founder's own rows** is not touching a
client record; it is the same data as the WhatsApp export he already provided, plus the state the
product read at the time. It is Phase 1 material, not Phase 2.

The Phase 2 governance gate applies to **other members' rows**, and it stays shut.

Two controls should be built in rather than promised:

- The adapter takes **one** `user_id` and refuses a query without it — no "all users" path exists
  to be reached by accident.
- Output lands in gitignored `p2-work/`, exactly as the transcript corpus does.

The instrument's **no-model-call, no-network** property is unaffected: this reads a database the
product already owns and sends nothing anywhere.

**This is the strongest technical argument for a narrow, founder-only ledger read**, and it is
distinct from the Phase 2 question, which remains blocked behind the six governance questions.

## 6. Proposed acceptance boundary for the next measurement run

The next run is accepted if, and only if:

1. **Corpus:** founder's own turns only, from both sources — WhatsApp export (reach) and Turn
   Ledger (provenance). No other `user_id` is read.
2. **Parser:** media turns parse correctly (LTR mark), voice transcripts are re-attributed to the
   member, and pipeline messages are excluded from coach turns. **Regression-tested**, because
   this class of bug has now caused a wrong headline once.
3. **Accountability:** scoreable on at least **80%** of turns using `state_read`. Below that, the
   ledger did not close the gap and the result must say so.
4. **Continuity:** provenance check **ACTIVE**, not UNAVAILABLE.
5. **Layers stay separate:** rates from the population only; the selected sample yields
   distributions only. No number crosses.
6. **Every reliability finding is traced to a cause before it is reported as a rate.** The 17%
   error happened because a number was reported before its mechanism was checked. This is the
   acceptance criterion I would most like held against me.
7. **`coaching_value` stays capped** at the highest anchored level until a founder-anchored 5 exists.
8. **No coaching-code changes.** Measurement only, until the boundary is accepted.

**Not in scope for the next run:** any change to Coach K, any prompt edit, any new handler, any
architecture movement, any model-based scoring, any client data.

---

## What this does and does not say

The corrected picture: **reliability is a 4% problem in this corpus, not 17%, and the coaching
findings stand as the main event.** The voice pipeline works. The parser did not.

It still describes one member — the founder — over seven days, and says nothing about a paying
member who did not help design the product.
