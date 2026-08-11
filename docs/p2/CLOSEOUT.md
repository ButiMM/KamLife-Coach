# P2-C CLOSEOUT — Final Measurement Report

**Scope:** close the five specific gaps, report, stop. No coaching code, no architecture, no new corpus.
**Run:** `npx tsx script/p2-measure.ts`

---

## 1. Corrected corpus integrity

Canonical corpus, corrected importer, 10 conversations 2026-08-05 → 08-11:

| | count |
|---|---|
| member turns | 111 |
| — of which voice-transcribed | **16** |
| — member image turns | 2 |
| — multi-part (multiple sentences or lines) | 13 |
| — long (≥25 words) | 2 |
| coach turns (total) | 143 |
| — pipeline (voice ack, photo ack, transcript echo, media) | 44 |
| — **scoreable coaching turns** | **97** |
| — meal-card / media outputs | 8 |

All five media classes the directive named are represented and correctly attributed. The 16 voice
turns carry their transcript as the member's own words; pipeline messages are excluded from
scoring; meal-card headers are paired with the image they introduce.

## 2. Founder validation — **BLOCKED, awaiting the founder**

Five scores are prepared below, one per dimension. **I cannot record founder validation myself**;
confirming or overturning these is the founder's act and inventing it would defeat the purpose.

| # | turn | dimension | Claude's score | reason given | founder: confirm / overturn |
|---|---|---|---|---|---|
| 1 | 08-06 15:30 — *"Read my entire paragraph ❗️❗️❗️"* → brochure reply | **Understanding** | 1 | Recurrence rule: the same complaint repeated produced substantially the same reply | ☐ |
| 2 | 08-07 06:00 — *"Show me my weeks progress"* → "You've lost 1.0kg… 83.3kg" | **Continuity** | 1 | Weight invented against no weigh-in | ☐ |
| 3 | 08-06 15:30 — *"Be the coach. Coach me."* → "Let's focus on the next steps" | **Actionability** | 1 | No next step present after every ambiguity was removed by the member | ☐ |
| 4 | 08-07 06:00 — *"Omg❗️❗️❗️"* → "What do you want to tackle first?" | **Humanity** | 1 | Third consecutive apology-then-question at the emotional peak | ☐ |
| 5 | 08-08 14:15 — *"I want to have 3 ciders today"* | **Accountability** | 1 | Correctly did not moralise; then counted nothing and adjusted nothing | ☐ |

This is a **directional calibration check**, not proof of calibration. Five confirmations would
mean my reading of the standard is roughly aligned; disagreements are more useful than agreements.

## 3. The 16 recovered voice turns — the closeout's main finding

**All 16 received no coaching reply of their own.** Every one was transcribed and echoed back;
none was answered before the member spoke again.

This is not a coaching-quality result. It is a **delivery** result, and it means Understanding,
Continuity and Actionability are **not scoreable** on these turns — there is no reply to judge.
Scoring them anyway would be inventing evidence.

| | |
|---|---|
| voice turns recovered | 16 |
| received a coaching reply of their own | **0** |
| Understanding / Continuity / Actionability | **UNRESOLVED — no reply exists** |
| Actionability, treated as delivered outcome | **1** — nothing to act on reached the member |

### The confound, addressed rather than hidden

The member sends voice notes 19–106 seconds apart, so "no reply before he spoke again" could
just be impatience. It is not:

- Typed messages are answered in **~6 seconds** (11:54:55 → 11:55:01).
- In 20260807-1150 there is a **290-second window (4m50s) with no coach speech at all** while six
  voice notes arrived — only echoes.

Typed input answers in seconds; six voice notes produced nothing for nearly five minutes.

### Corrected population figures — and a correction to my own correction

MEASUREMENT-GAPS.md said 97% of voice notes received a substantive reply. **That was wrong too:
it counted the `🎤 I heard:` transcript echo as a reply.** Corrected, across all 408 voice notes
in the full export:

| measure | rate |
|---|---|
| real coaching reply before the member speaks again | 83/408 = **20%** |
| real coaching reply within 5 minutes | 205/408 = **50%** |
| real coaching reply within 15 minutes | 235/408 = **58%** |
| **voice *bursts* eventually answered** | **206/209 = 99%** |

Honest reading: **Coach K almost always says something eventually after a burst of voice notes,
but roughly half of individual voice notes are never answered on their own.** The pipeline
delivers transcription reliably and coaching unreliably.

### C4 / C6 flags in the voice turns

- **C6 (multi-part ignored)** — present and severe. V1 carries a whole day's food (*"4 slices of
  bread, 4 eggs, 4 fish fingers, black coffee…"*) and receives no reply. V9 carries training,
  mood and session status at once. This is exactly principle 6's case, and it fails.
- **C4 (invented state)** — one candidate, V5: *"The bread, eggs, avocado, and black coffee are
  inaccurate. Remove that meal."* The next coach speech is *"Done — Rice and minced beef logged
  for dinner"* — which names a different meal than the one he asked to remove. This is the
  wrong-meal deletion pattern arriving through the voice path. **Flagged, not scored**, because
  the transcript cannot show which row was touched — that is exactly the ledger gap in §4.
- **Transcript elision** — several echoes end in `…`, so the full content of a long note is not
  recoverable from the export at all.

**No new anchors were created for voice turns**, per the directive.

## 4. Turn Ledger inspection — `LEDGER_UNAVAILABLE`

Inspected the schema and every write path. **The ledger does not contain the evidence needed.**

| field | status |
|---|---|
| `input_text`, `reply`, `reply_ms`, `version`, `resolved_day` | written on every turn (`routes.ts:134` wraps all turns via `inTurn`) |
| `mutations` | **4 call sites only** — meal insert, meal drop, correction, multi-intent. No steps, water, workout, or weight writes |
| `state_read` | **1 call site** — `food-log-mgmt.ts:154`, inside the correction branch only |

`state_read` is null for essentially every turn. The question P2 needs answered — *what
information did Coach K have available when it produced this reply?* — **cannot be answered from
the existing ledger.** No targets, no running totals, no adherence state, no weigh-in status.

**No production access from this container either** (`DATABASE_URL` not set), so even the one
populated branch could not be sampled.

## 5. Adapter — **NOT BUILT**

Per directive §4: the required evidence does not exist, so no adapter was built, nothing was
reconstructed or guessed, and **no product change was made to create the evidence**.

Building a read-only adapter now would return `LEDGER_UNAVAILABLE` for every field that matters.
That is a decision for P2-D: instrumenting `turnState()` at the points where Coach K reads
targets and totals is a *product* change, and it is explicitly out of scope here.

## 6. Remaining evidence gaps

1. **Accountability is not measurable.** Needs `state_read` populated where the coach reads
   targets/totals/adherence. Currently 1 call site.
2. **C4 is not verifiable.** Confirming a wrong-meal deletion needs `mutations` on the row
   actually touched — present for meals, absent elsewhere.
3. **Voice content is partially unrecoverable.** Long transcripts are elided with `…`, and the
   audio is never available, so mis-transcription is indistinguishable from bad reasoning.
4. **Level 5 remains unobserved** on four of five dimensions; `coaching_value` stays LOCKED at 5.
5. **One member, seven days.** Nothing here extends to a paying member who did not build the product.

---

## Standing findings carried into P2-D

- **Reliability: ~4% genuine defects** (1 build artifact, 3 truncations of 97). A monitoring
  signal, not a blocker.
- **The causal finding holds:** the truncated `"…for these spots:"` produced *"Read my entire
  paragraph ❗️❗️❗️"* and the anchored Understanding-1 failure. A plumbing defect manufactured a
  coaching defect.
- **New, and larger than either:** roughly half of individual voice notes get no coaching reply.
  In a market where voice is a primary input, that is a delivery gap, not a quality gap.
- Coaching distributions stand as provisional: understanding strongest (3.00), actionability and
  humanity weakest (2.42), accountability mostly UNRESOLVED.

**Measurement stops here.** No further phase, no new corpus, no new instrument.
