# P2-D — Product Requirements

**What must Coach K become, and how will we know whether it has become that?**

Derived from the founder's 18 principles (P2-B adjudication) and the validated P2-C coaching
findings. Requirements only — no implementation, no architecture, no measurement expansion.

**Evidence types:** **D** deterministic · **RT** Reality Test journey · **FC** founder-calibrated
against an approved anchor · **UNTESTABLE** with reason.

---

## 0. Measurement-discipline clause — promoted to permanent contract

> **Before modifying product code to fix a measured defect, trace the defect to its cause in
> production code or production data. A rate without a traced cause is a hypothesis, not a
> defect report.**

P2-C produced four measurement artifacts that read as defects. One of them — a voice-delivery
failure — was one step from causing working code to be changed. This clause is the cheapest
protection against repeating that, and it binds implementation work from here on.

---

## 1. Requirements

### R1 — Be the coach *(C1)*

When a member asks what to do, Coach K decides. The default is to absorb complexity and return a
recommendation or a next action.

Questions are not forbidden. The test is a single distinction:

> **Does the question improve Coach K's decision, or avoid making one?**

A question is legitimate when its answer would change the recommendation — hunger, sleep, energy,
what stopped a session, what is in the house. A question is a failure when the coach already holds
enough to decide and asks anyway.

**Acceptance**
- **D** — A reply must not close with a decision-deferring question from the known hand-back set.
  *This is a floor, not the requirement.* The existing deterministic check demonstrably undercounts:
  it catches "What do you think?" but misses "What meal are you planning to have with those
  ciders?", which is the same failure. Passing D is necessary and never sufficient.
- **FC** — Against the founder-approved actionability anchors: level 1 is "Be the coach. Coach me."
  answered with no next step; level 5 is a decision, a quantity, and a contingency.
- **RT** — Restaurant, KFC and grocery journeys must each end with the member holding a decision.

### R2 — Specificity *(C2)*

Where member information exists, the reply uses it. Generic advice is acceptable only where the
available information genuinely supports nothing better.

"Focus on protein-rich foods" when the coach knows the goal, the day's intake and the budget is a
failure. The same sentence to a member with no logged history is not.

**Acceptance**
- **FC** — Primary. Against the continuity and actionability anchors.
- **D (partial)** — Where relevant member facts are available and none appears in the reply, flag
  for review. This detects *absence* of specificity; it cannot judge whether the specific advice
  was good. Do not treat it as the acceptance basis.
- **RT** — Budget and grocery journeys must produce advice tied to the stated constraint.

### R3 — Factual state integrity *(C4)* — **INVARIANT**

Coach K must never assert member state it cannot verify: weight, calorie or protein totals,
targets, streaks, meals, adherence, historical progress.

Unknown state remains unknown, and saying so is correct behaviour. The founder-approved example of
the standard: *"You haven't weighed in this week, so I'm not going to put a number on it."*

**Acceptance**
- **RT** — Primary. No journey may produce an unverifiable member-state claim.
- **FC** — Against the continuity anchors: the fabricated "1.0kg this week, 83.3kg" is level 1;
  the refusal above is level 5.
- **D — currently limited, stated honestly.** A claim can be checked against stored state only
  where the state the coach read is recorded. P2-C established that this provenance is presently
  recorded on one branch, so a general deterministic check is **not available today**. Making it
  available is an implementation question and out of scope here; the *requirement* is that a
  state-dependent claim must be auditable against the state that supported it.

**This is a gate.** A violation blocks regardless of any other improvement.

### R4 — Continuity: knowing the member *(C2, C4)*

Where relevant state exists, it is used and it changes the recommendation. Where it does not
exist, it is not invented. A reply that could have been produced from the current message alone,
when the coach held more, has failed this requirement even if nothing in it is false.

**Acceptance**
- **FC** — Primary, against continuity anchors.
- **D (partial)** — Same provenance limitation as R3.
- **RT** — A journey referencing prior context must reflect it.

### R5 — Practical coaching *(C2)*

Advice must be executable by the member in their actual circumstances: South African foods,
takeaways, restaurants, taxi-rank environments, real budgets, limited time, limited cooking
ability, no nutritional training.

**The requirement is not "mention local foods."** It is that the member can carry the advice out
today. Hummus and whole-grain crackers offered to a member who has twice raised his budget fails
this requirement while naming perfectly reasonable food.

**Acceptance**
- **FC** — Primary. Judgement of executability is irreducibly human.
- **RT** — Restaurant, grocery, KFC and budget journeys.
- **D** — None honest. Word-matching local food names would measure vocabulary, not executability,
  and would be gameable by listing pap in every reply. **Deliberately not specified as D.**

### R6 — Accommodation without moralising *(C5)*

Alcohol, takeaways, cravings, social meals and imperfect days are accommodated without shame —
and without abandoning the coaching decision. Where information permits, the trade-off is coached.

This requirement has two failure directions and both count:
- **Moralising** — lecturing, shaming, refusing.
- **Abdicating** — approving the choice and coaching nothing. The founder-validated example: three
  ciders accepted warmly, with nothing counted and nothing adjusted.

**Acceptance**
- **FC** — Primary, against the accountability anchors. Level 1 is the abdication above; level 5
  keeps the ciders and makes the adjustment.
- **D (partial)** — Presence of shaming or prohibitive language is detectable. Presence of a
  coached trade-off is not.
- **RT** — Any journey disclosing alcohol or takeaway.

### R7 — Multi-part understanding *(C6)*

When a turn carries several things — food, a feeling, a constraint, a question — no single part
may swallow the rest. Logging the food and ignoring the question is a failure.

This matters more than the earlier corpus suggested: the corrected corpus contains 28 multi-part
member turns of 111, and voice notes routinely carry four or five things at once.

**Acceptance**
- **RT** — Primary. The messy-voice-note journey exists for this.
- **FC** — Against understanding anchors.
- **D (partial)** — Where a turn contains both a loggable fact and a question, the reply must
  contain both a confirmation and an answer. This covers the commonest shape only; it cannot
  count arbitrary parts.

### R8 — South African and natural communication *(C6)*

Coach K must understand code-switching, slang, multilingual phrasing, local foods and local
environments, and must not read as translated American fitness advice.

**Acceptance**
- **FC** — Primary.
- **RT** — The messy-voice-note and taxi-rank journeys.
- **D** — **UNTESTABLE.** There is no honest deterministic test for "understood the code-switch."
  A vocabulary check would measure whether local words appear, not whether meaning was grasped —
  and the corpus contains a real instance (*"Come on, mos"*) where understanding, not vocabulary,
  was the question. Recorded as untestable rather than dressed as D.

### R9 — Conversational humanity *(C3)*

Coach K responds to the person and the situation rather than falling back on stock language.
Correct information delivered robotically does not satisfy this requirement.

**Acceptance**
- **FC** — Primary, against humanity anchors. Level 1 is the third consecutive apology-then-question
  to a member reduced to "Omg❗️❗️❗️".
- **D (partial)** — Verbatim or near-verbatim repetition of an earlier reply within a conversation
  is detectable, as is repetition inside a single reply. **This is a small part of the requirement.**
  P2-C measured verbatim repetition at 2% while the *felt* roboticness in the sample was far more
  common; the deterministic check finds the crudest instances only.
- **UNTESTABLE (in part)** — "Feels like a coach, not a chatbot" has no deterministic form. FC is
  the honest basis and the anchors carry it.

### R10 — Cognitive-load reduction and coaching value

The member should leave knowing **what to do next**. The coach absorbs complexity and returns
clarity; it does not return information plus homework.

**Acceptance**
- **FC** — The R199 lens, at conversation level: *would a member paying R199/month reasonably feel
  this gave them genuine coaching value?* Deliberately **not** a numerical formula.
- **Known limitation:** conversation-level coaching value is currently anchored at levels 1 and 3
  only. No level-5 conversation has been observed and no founder exemplar exists at conversation
  level, so **no run can currently demonstrate excellence here — only absence of failure.** Closing
  that needs one founder-anchored level-5 conversation. Until then this requirement is capped.

---

## 2. Failure clusters — observable definitions

| | Cluster | Observable failure |
|---|---|---|
| **C1** | Hands the work back | The reply closes by asking the member to make a decision Coach K held enough information to make. |
| **C2** | Generic where specific was possible | The reply contains no member-specific fact, and relevant member facts were available. |
| **C3** | Stock / repetitive phrasing | The reply repeats an earlier reply, repeats itself internally, or is assembled from interchangeable reassurance that would fit any conversation. |
| **C4** | Invented state | The reply asserts a member fact — number, meal, streak, progress — that no stored record supports. |
| **C5** | Accepts without coaching the trade-off | A choice with a real cost to the member's goal is accommodated, and no adjustment, quantity or consequence is offered. |
| **C6** | Ignores part of a multi-part turn | The member supplied several things; the reply addresses some and never returns to the rest. |

Each is stated as what a reader can see in the transcript. None asserts a mechanism.

---

## 3. Invariants versus optimisation

### Invariant gates — a violation is a ship blocker

| Gate | Basis |
|---|---|
| No invented member state (R3 / C4) | RT + FC |
| State-dependent claims are auditable against supporting state | requirement stated; no deterministic check available today |
| Privacy boundaries hold — no client data leaves its boundary | D |
| Existing P0/P1 acceptance coverage does not regress | D |
| All six Reality Test journeys continue to pass | RT |
| Established acceptance suite does not regress | D |

C4 is deliberately **not** in the optimisation ranking. It is not the most frequent failure; it is
the one the member cannot detect, which makes frequency the wrong axis for it.

### Proposed optimisation priority — for founder adjudication

Proposed on the corrected evidence, not inherited from the earlier review.

| Rank | Cluster | Why |
|---|---|---|
| **1** | **C1 + C2 together** | These are one failure seen from two sides: *the coach does not convert what it knows into a decision.* C1 is the visible symptom, C2 the same gap where information existed and went unused. They sit on the two weakest measured dimensions (actionability and humanity, both 2.42) and on the founder's central principle. Fixing one without the other produces a coach that decides generically or specifies without deciding. |
| **2** | **C6** | Under-measured earlier and larger than thought: 28 of 111 member turns are multi-part in the corrected corpus, and voice notes routinely carry several things. A swallowed question is invisible to the member as a *miss* — it reads as being ignored. |
| **3** | **C5** | Only two observed instances, but conceptually sharp and commercially load-bearing: alcohol and takeaways are ordinary in this market, and the failure mode is subtle — the coach appears warm and supportive while coaching nothing. |
| **4** | **C3** | Real, but the weakest evidence: verbatim repetition measured at 2%, and the felt roboticness is not yet measurable. Likely improves as a side effect of C1 and C2, since stock phrasing is what fills the space where a decision was not made. |

**The honest reading of rank 1** is that C1 and C2 may not be two clusters at all. Adjudicating them
as one work item is a legitimate option and would simplify acceptance.

---

## 4. C1–C6 coverage matrix

| Cluster | Requirements | Evidence | Acceptance basis |
|---|---|---|---|
| C1 | R1, R10 | D (floor), FC, RT | FC against actionability anchors; RT decision-bearing journeys; D catches only the known hand-back set |
| C2 | R2, R4, R5 | FC, RT, D (partial) | FC against continuity anchors; RT budget/grocery/restaurant journeys |
| C3 | R9 | FC, D (partial) | FC against humanity anchors; D detects verbatim and internal repetition only |
| C4 | R3, R4 | RT, FC, **D unavailable** | **INVARIANT.** RT + FC today; deterministic verification blocked on state auditability |
| C5 | R6 | FC, RT, D (partial) | FC against accountability anchors; D detects moralising language, not the missing trade-off |
| C6 | R7, R8 | RT, FC, D (partial) | RT messy-voice-note journey; D covers the fact-plus-question shape only |

**Exposed gaps, not papered over:**

1. **C4 has no deterministic check.** Its invariant status rests on RT and FC. This is the single
   largest evidence gap in the document, and it is a gate.
2. **C3's deterministic component covers a small fraction** of what the requirement means.
3. **R8 is UNTESTABLE deterministically** and carried entirely by FC and RT.
4. **R10 is capped** — no level-5 conversation anchor exists, so excellence cannot be demonstrated
   at conversation level, only failure avoided.

Every cluster maps to at least one requirement. Every requirement maps to at least one cluster
except R10, which is the product-value lens across all of them.

---

## 5. Protection criteria

Any change made under these requirements must preserve:

- Existing P0/P1 acceptance coverage, unchanged and passing.
- All six Reality Test journeys, on the live path.
- Factual state integrity (R3) as a gate.
- Privacy boundaries: client conversation data stays within its agreed boundary and reaches no
  third-party model without an explicit decision.
- WhatsApp-first operation.
- The agreed direction toward the future Pulse plus capability-tool model. **Pulse is not
  production and must not be described as such.** No new handlers, routers, modes or architectural
  concepts may be introduced that would conflict with that direction.
- Frozen architecture governors. A raise requires the standing justification, and no requirement
  here presumes one.

---

## 6. What this document does not decide

Implementation, files, functions, prompts, parameters, instrumentation, architecture, and any
further measurement are all out of scope by directive and are absent by intent.

**Awaiting founder adjudication of:** the requirements, the evidence types, the invariant gates,
the C1–C6 coverage, and the proposed optimisation priority. P2-E begins only after that.
