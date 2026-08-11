# P2-C — Measurement Result

**Corpus:** founder's own Coach K conversation, 2026-08-05 → 08-11. 10 conversations, **109 coach turns**.
**Standard:** the founder's P2-B adjudication (18 principles), via the 17 anchors in `anchors.json`.
**Scored by:** Claude, applying the founder's written standard. **Not founder-scored.** Every turn
carries a reason and is overturnable individually — this is a proposed measurement, not ground truth.
**Run:** `npx tsx script/p2-measure.ts` · **No coaching code changed.**

---

## 0. A correction to P2-B, before anything else

**P2-B quoted cluster frequencies out of the 25-turn calibration sheet. That sheet was selected
for spread — it deliberately over-samples rare strata so the anchors reach the edges. Frequencies
taken from it are biased by construction and are not rates.** "11 of 19 turns hand the work back"
reads like a rate. It is not one, and it should not have been presented in a table that invited
being read as one.

P2-C therefore measures twice, and the difference is large:

| | selected sample (biased) | full population (unbiased) |
|---|---|---|
| C1 — hands the work back | 11 / 19 = 58% | **8 / 90 = 9%** |

The priority hypothesis was built partly on the first number. The second is the honest one, with
an important caveat in §1 below.

## 1. Population layer — 109 turns, deterministic, nothing selected

| measure | rate |
|---|---|
| **Infrastructure artifacts sent to the member as a reply** | **19 / 109 = 17%** |
| — listening placeholder (`🎤 Coach K is listening…`) | 14 |
| — raw Twilio transport error | 4 |
| — build artifact (`🚀 Running build`) | 1 |
| Coaching turns (denominator below) | 90 |
| **C1** — ends by handing the work back | **8 / 90 = 9%** |
| **C3** — verbatim repeat of an earlier reply | 2 / 90 = 2% |
| Truncated reply (dangling terminator only) | 3 / 109 = 3% |

**The C1 rate is a floor, not a measure.** It uses the shipped `HANDBACK_QUESTION` predicate,
which matches a fixed list of closing questions. It catches "What do you think?" and "What's your
plan for meals today?" but misses "What meal are you planning to have with those ciders?" and
"What's one meal you can plan for today?" — both of which are hand-backs by the founder's
definition. The true rate sits between the 9% floor and the sample layer's much higher density.
**Do not quote 9% as the answer.** It is the part we can prove.

C2, C4, C5 and C6 are not machine-detectable at all and appear only in the sample layer.

## 2. The result that outranks the coaching findings

**17% of everything Coach K sent was not a coaching reply at all.** Fourteen listening
placeholders, four raw Twilio errors, one build artifact.

This is larger, by rate, than any measured coaching defect — and it is worse than that number
suggests, because it **destroyed the measurement itself**:

> **4 of 10 conversations could not be scored for coaching value.** Not because the coaching was
> ambiguous, but because infrastructure noise left too little coaching to judge.

Principle 18 says a broken pipe must not become evidence that the coach lacks humanity. That
holds. But the corollary is now visible: **a broken pipe can prevent the coach from being
measured at all**, and in this corpus it did so 40% of the time.

There is also a direct causal chain, not just co-occurrence. Sheet #6 — the anchor for
Understanding 1 — exists *because* the preceding reply truncated at `"...for these spots:"` and
answered restaurants when he asked about groceries. The member said "Read my entire paragraph",
and the failed recovery is the anchored coaching failure. **The infrastructure defect caused the
coaching defect.**

## 3. Sample layer — 19 coaching turns, scored against the anchors

Distributions only. **These are not rates** and must not be quoted as percentages.

| dimension | 1 | 2 | 3 | 4 | 5 | UNRESOLVED | mean |
|---|---|---|---|---|---|---|---|
| understanding | 3 | 2 | 6 | 8 | 0 | 0 | 3.00 |
| continuity | 1 | 5 | 6 | 2 | **1** | 4 | 2.80 |
| actionability | 3 | 6 | 9 | 1 | 0 | 0 | 2.42 |
| humanity | 4 | 5 | 8 | 2 | 0 | 0 | 2.42 |
| accountability | 1 | 3 | 3 | 0 | 0 | **12** | 2.29 |

Three things in this table matter more than the means.

**Understanding is the strongest dimension (3.00) and actionability/humanity the weakest (2.42).**
Coach K largely *grasps* what the member said. What it does with that is where it fails. That is
consistent with the founder's central principle: the problem is not comprehension, it is that the
coach does not decide on the member's behalf.

**No dimension produced a single 5 except continuity, once.** Eighty-nine of the 90 scored
dimension-values across the sample fall at 4 or below.

**Accountability is UNRESOLVED 12 times out of 19** — the largest gap in the whole measurement.
A transcript rarely shows whether something *needed* correcting; that requires the member's
adherence state, which lives in the database. Accountability is currently barely measurable.

## 4. Conversation-level coaching value

`coaching_value` is **LOCKED at level 5** — no anchor exists. Scores are therefore **capped at 3**:
levels 1 and 3 are anchored and judgeable, and nothing may be certified above the highest anchored
level. A conversation that might exceed 3 is recorded UNRESOLVED, never a 4.

| conversation | value |
|---|---|
| 08-06 13:03 | 3 |
| 08-08 06:00 | 3 |
| 08-05 12:37 | 2 |
| 08-08 14:15 | 2 |
| 08-06 15:30 | 1 |
| 08-07 06:00 | 1 |
| 08-06 18:47 · 08-07 11:50 · 08-07 16:27 · 08-11 08:21 | **UNRESOLVED — infrastructure** |

**Scored 6 of 10. Highest observed: 3. None above 3.**

## 5. Anchor coverage

| target | observed | specified | state |
|---|---|---|---|
| understanding | 2 | 1 | UNLOCKED |
| continuity | **3** | 0 | UNLOCKED |
| actionability | 2 | 1 | UNLOCKED |
| humanity | 2 | 1 | UNLOCKED |
| accountability | 2 | 1 | UNLOCKED |
| coaching_value | 2 | 0 | **LOCKED — missing level 5** |

Continuity is the only dimension anchored entirely on observed turns, because it is the only one
where the corpus contained a real 5.

**Continuity provenance remains UNAVAILABLE corpus-wide.** A transcript carries no Turn Ledger, so
continuity was scored *only* where the transcript itself carries the evidence — a contradiction of
something visible in the conversation. It was never inferred from what a reply sounded like. That
is why it has 4 UNRESOLVED.

## 6. Contradictions and ambiguities

1. **Understanding 1 vs 2 on sheet #6.** The reply did recover the topic. Resolved to 1 on the
   recurrence rule. The boundary is therefore "right topic, wrong act" — recorded, not hidden.
2. **The ciders turn scores accountability 1 and actionability 3 from the same words.** Not an
   inconsistency: "did not moralise" and "did not coach" are different measurements. This is
   cluster C5 in a single turn.
3. **`coaching_value` unresolvable at 5, corpus-wide.**
4. **Two distinct repetition shapes.** C3 is repetition *across* turns. Sheet #23 repeats itself
   *inside one message* — "No meals logged yet today. I don't have a meal logged for you today."
   The population check only counts the first shape.
5. **Necessary questions are not hand-backs.** Sheet #25 asks "What did you have for breakfast?"
   and cannot log without it. Scored 3, recorded deliberately as the contrast case. The defect is
   not asking; it is asking *instead of deciding*.

## 7. What was not measurable

- **Accountability**, in 12 of 19 turns — needs adherence state from the database.
- **Continuity**, in 4 of 19 turns, and its machine provenance check corpus-wide.
- **Coaching value**, in 4 of 10 conversations — infrastructure noise.
- **Level 5 on four of five dimensions** — the corpus contains no example.
- **C2, C4, C5, C6 rates** — not machine-detectable; only present in a biased sample.
- **Anything about members who are not the founder.** One member, seven days, the person who
  built the product. No claim here extends to a real paying member, to retention, to willingness
  to pay, or to health outcomes.

## 8. Evidence required before P2-D

1. **A Turn Ledger–backed corpus.** It converts accountability from mostly-UNRESOLVED to
   measurable and switches continuity's provenance check on. Blocked behind the Phase 2
   governance gate — this is the strongest technical argument for opening it.
2. **A better C1 detector, or a hand-counted C1 rate over all 90 turns.** The current floor is
   provably incomplete and the priority order partly rests on it.
3. **At least one founder-anchored level 5 for `coaching_value`** — otherwise no future run can
   ever show improvement at conversation level, only absence of failure.
4. **A second corpus that is not the founder** — the whole point of Phase 2.
5. **A decision on whether infrastructure defects are P2's business at all.** They are currently
   excluded from the rubric by principle 18 and are, by rate, the largest measured defect.

## 9. Against the founder's priority hypothesis

Stated as evidence, not as a recommendation. **The fix decision is the founder's (P2-D).**

| priority | cluster | what the measurement says |
|---|---|---|
| P0 | C4 invented state | **Supported.** Rare (2 in the sample) but it produced the only "Do better" in the corpus and the anchored continuity 1. Severity confirmed; frequency low. |
| P1 | C1 hands work back | **Partly challenged.** Population floor is 9%, not the 58% the biased sample implied. Still the most common *scored* failure and the detector undercounts — but the gap between 9% and 58% is large enough that the priority should not rest on the sample number. |
| P1 | C2 generic | **Supported.** Actionability and humanity are the two weakest dimensions, and C2 is the mechanism behind both. |
| P1 | C3 stock phrasing | **Partly challenged.** Verbatim repetition is 2% at population level. The *felt* roboticness in the sample comes from stock phrasing and structure, which this instrument cannot yet count. |
| P2 | C6 multi-part ignored | **Under-measured.** Only 2 instances, and the corpus has almost no voice notes — the case where it matters most is absent. |
| P2 | C5 no-moralise-no-coach | **Supported and sharper than stated.** It is not one cluster but a split: humanity 4 and accountability 1 from the same reply. |
| — | **infrastructure** | **Unranked, and larger by rate than anything ranked.** 17% of all replies; destroyed 40% of the conversation-level measurement; caused at least one anchored coaching failure directly. |

The last row is the finding I would put in front of the founder first. It is outside the coaching
rubric by design, and by the numbers it is the biggest thing in the corpus.
