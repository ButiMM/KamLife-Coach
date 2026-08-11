# P2-B — Calibration Result

**Corpus:** the founder's own Coach K conversation, 2026-08-05 → 08-11. 10 conversations,
109 coach turns, 25 selected for calibration.
**Standard:** the founder's P2-B adjudication of 2026-08-11 (18 numbered principles).
**Status:** 5 of 6 targets anchored. `coaching_value` LOCKED. No coaching code changed.

---

## 1. The headline finding

**The corpus contains no example of a level-5 conversation, and only one observed level-5 turn.**

That is not a shortfall in the instrument. It is the measurement. Across ten consecutive real
conversations with the product, in the week the product was being actively rebuilt, there is
exactly one turn that meets the founder's own written standard for excellence on any dimension —
and no conversation as a whole that a member would rationally keep paying for.

The one observed 5 is **continuity**, and it is worth reading next to its opposite:

| | |
|---|---|
| **08-07, continuity = 1** | "You've lost 1.0kg this week, bringing you to 83.3kg." He had not weighed in. |
| **08-08, continuity = 5** | "You haven't weighed in this week, so I'm not going to put a number on it. Hop on the scale in the morning and I'll tell you exactly where you're going." |

Same product, two days apart, opposite behaviour on the same question. The good version already
exists in the system. It is not reliably reached.

## 2. Anchors

17 anchors, 3 recorded ambiguities. Every one cites the founder principle it rests on, and
carries one of two provenances — **never machine-invented**:

- **`observed`** (12) — a real turn from the corpus.
- **`specified`** (5) — an exemplar the founder wrote in the adjudication itself. Used only where
  the corpus contains no example of that level. He wrote the words; the instrument did not.

Level-5 anchors are `specified` for understanding, actionability, humanity and accountability,
because **no observed turn reached 5 on any of them**. That fact is the finding, not a workaround.

## 3. Failure clusters

Ranked by how often they appear across the 19 coaching turns.

### C1 — The coach hands the work back (11 of 19 turns)
**The dominant defect.** Principles 2 and 13. The member arrives with complexity and leaves with
a decision to make. Its purest form:

> **Member:** That's your job to coach and tell me what I should do next. I don't want to think
> about it. Be the coach. Coach me.
> **Coach K:** I understand, Kam. Let's focus on the next steps to help you reach your muscle gain goal.

Every ambiguity was removed by the member first, and the reply still contains no next step.
Three consecutive turns on 08-07 end in a question, the last one to a member whose message had
degraded to "Omg❗️❗️❗️".

### C2 — Generic advice where specific advice was available (9 of 19)
Principles 3 and 10. "Focus on protein-rich foods", "keep it balanced", "make sure to drink
enough water", "I'm here to support you every step of the way". Each is defensible and none uses
what the system already knows — goal, targets, budget, what he ate, what he said an hour ago.

### C3 — Stock phrasing repeated until it reads as machinery (7 of 19)
Principle 12. The apology-then-question pattern appears three times consecutively on 08-07. Two
replies in the same conversation are near-identical paragraphs. The problem is the pattern, not
the wording.

### C4 — Invented or unusable state (2 of 19, highest severity)
Principle 16-Continuity. A fabricated weight loss and body weight. Rare, but it is the class of
defect the member cannot detect — a number that sounds like their own history. Directly triggered
"No I didn't give you any measurements this week. Do better."

### C5 — Not moralising, but also not coaching (2 of 19)
Principle 8 vs 9. Alcohol and takeaways are handled without judgement, which is correct and is
what makes a member willing to tell the truth. But the arithmetic is then never done: three
ciders, no number, no adjustment, no trade-off. **"Did not moralise" and "did not coach" are
different measurements** — the same ciders turn scores accountability 1 and actionability 3.

### C6 — Ignoring half of a multi-part message (2 of 19)
Principle 6. He asked about grocery lists and got restaurants. Voice-note and run-on messages are
first-class input in this market, and this is the same failure the six-journey Reality Test
already tests for.

## 4. Coaching failures vs infrastructure defects

Principle 18. **A broken pipe is not evidence that the coach lacks humanity.** Six of the 25
selected turns are plumbing and are excluded from the rubric — but retained as defect evidence.

| # | Turn | Class |
|---|---|---|
| 1 | `🚀 Running build` | build artifact reaching a client |
| 9, 10, 18 | `🎤 Coach K is listening…` | listening placeholder sent as a reply — twice byte-identical |
| 19 | `*Today's food log (2 meals):*` then nothing | **truncation** |
| 24 | Raw Twilio sandbox error, including the member's own phone number | transport failure |

**Truncation is a pattern, not an incident — three instances in the corpus:**
`"...for these spots:"` (nothing follows) · `"You're doing great on tracking! specific. 👌"` ·
`"*Today's food log (2 meals):*"` (no log). The first one directly caused the C1/C6 failure
sequence on 08-06: he complained about a broken reply and the recovery attempt made it worse.

Turn 24 also puts a raw phone number in front of the member, which belongs with the logging
findings in `docs/BACKLOG.md`.

## 5. Coverage

| target | 1 | 3 | 5 | state |
|---|---|---|---|---|
| understanding | observed | observed | *specified* | UNLOCKED |
| continuity | observed | observed | **observed** | UNLOCKED |
| actionability | observed | observed | *specified* | UNLOCKED |
| humanity | observed | observed | *specified* | UNLOCKED |
| accountability | observed | observed | *specified* | UNLOCKED |
| coaching_value | observed | observed | — | **LOCKED** |

`coaching_value` stays locked deliberately. No conversation in the corpus reaches level 5 and no
founder exemplar exists at conversation level, so it is marked UNRESOLVED rather than filled with
an invented certainty. A unit test pins this: if a 5 is ever found, the test fails and the change
has to be made on purpose.

**Continuity provenance remains UNAVAILABLE** for the whole corpus — a WhatsApp export carries no
Turn Ledger, so continuity was human-scored. That check lights up only if a controlled database
export is approved under the Phase 2 governance gate.

## 6. What this does not establish

Ten conversations from one member — the person who built the product — over seven days.
It does not establish retention, churn, willingness to pay, health outcomes, or how Coach K
behaves with a member who did not design the test. The clusters are real and repeated; their
*frequencies* are not a population estimate. §14: this run finds clusters, not scores.

## 7. Next

P2-C. **Do not optimise Coach K yet** — the failure clusters are named but not yet adjudicated
for which are worth fixing (P2-D). C1 is the largest and C4 the most severe; that ordering is a
product decision, not a measurement output.
