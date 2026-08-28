# KamLife — One-Shot Implementation Spec
**For:** CTO + builder  
**From:** Grok (adversarial / architecture)  
**Date:** 28 August 2026  
**Status:** Decision document. Do not treat as a 20-PR roadmap.  
**Head of record (as last stated):** production around `a633c7c` / post-#90–#91. Confirm SHA before cutting.

This is the way forward. It answers three questions only:

1. Can we finish this product in one shot, or not?
2. If yes — what is actually in that shot?
3. How do we go from the live 16:49 failure to a complete coach without another six months of organs?

---

## 0. Verdict

**Yes — we can finish the product in one engineering shot.**  
**No — we cannot finish the company in that same git commit.**

Those are different finish lines. Mixing them is why this has felt endless.

| Finish line | One shot? | Owner |
|---|---|---|
| The coach cannot contradict itself; one turn → one decision → one Coach K | **Yes. This is the shot.** | Engineering |
| The coach is useful at R199 for real SA food/gym life | **Mostly yes, in the same shot, as proof cases — not as a feature pile** | Engineering + founder sensor |
| Trademark, POPIA counsel, HPCSA/RD scope opinion, CIPC, bank, Meta | **No. Parallel, outside the shot** | Founder + professionals |
| Discovery-proof data moat, 100k conversations, white-label | **No. Not the product.** | Do not build |

The last nine PRs (#81–#91) were real. They were not the rebuild. They uncovered that **after a correct decision, something else can still speak.** The 16:49 thread is the acceptance test the architecture docs always described and never enforced.

**One shot means:** one mission, one branch, one merge, one composer law in production. Stacked commits allowed. Twenty sequential “ownership PRs” that each leave a second mouth alive are forbidden.

If the CTO cannot staff one builder on this branch until the gate is green, do not start. A half-shot is PR #92.

---

## 1. What “complete product” means (the only definition we will use)

KamLife is complete as a **product** when all of the following are true in production, on a real WhatsApp turn, for a paying or beta user:

1. **One inbound message is understood once.**
2. **Truth is read/written by named owners, once per fact.**
3. **Evidence is evaluated once.**
4. **One canonical decision is chosen.**
5. **One priority / one action is chosen.**
6. **Exactly one function composes user-visible Coach K text for that turn.**
7. **Nothing downstream may append a coaching act the decision did not select.**
8. **Hold means hold.** If the decision is “do not call a trend,” the outbound message contains no trend direction and no compensating prescription (“keep fuelling”).
9. **Identity matches the turn.** If the user says “second workout this week, lower day,” the reply may not invent “session 25 / first full training week” unless that is the stored fact — and if the store is wrong, the write owner is in this shot.
10. **Time matches the turn.** If the user talks about tomorrow, the reply may not close today.
11. **Tools honour the priority they are given.** If the decision says “129g protein is the priority,” meal options are a serious fraction of that gap or the message says this is one meal, not the whole gap.
12. **Wellness boundary is enforced in the composer, not only in a disclaimer.** Clinical / ED / disease-diet / “I am your dietitian” cannot ship as coaching acts.
13. **A human would pay ~R199** because the next action is specific, South African, and non-contradictory.

That is the finish line of the shot.

Not in the definition: Pulse purity theatre, patent, Shoprite, 20 new memory subsystems, a second constitution.

---

## 2. Why one shot is possible now (and was not in April)

We are not starting from zero. We are starting from a system that already:

- routes claimants (#81)
- owns durable writes (#84)
- owns truth (#85)
- has precedence (#86)
- has policy / evidence (#90)
- claims re-entry (#91)

The remaining hole is **final composition / orchestration**. That is one boundary. Fixing it in twenty PRs is how the old handlers keep winning: each PR leaves a leftover writer.

One shot is possible because:

- The organs exist.
- The failure is named.
- The proof cases already happened in production (16:45–16:49, 28 Aug 2026).
- The canonical docs already specify “one final Coach K response per turn.”
- Claude-gone is a staffing fact, not an architecture fact. One builder + this spec + Grok attack is enough for **this** boundary.

One shot is **not** “rewrite WhatsApp, PayFast, the LLM, and POPIA this weekend.”

---

## 3. The runtime law (non-negotiable)

Write this at the top of the branch README and in code as a test, not a comment.

```
For each inbound WhatsApp turn T:

  understood = understand(T)                          // once
  state'     = writeTruth(understood, state)          // named owners only
  evidence   = evaluate(understood, state')           // once
  decision   = decide(evidence, understood, state')   // exactly one
  messageOut = compose(decision, understood, state')  // exactly one function
  send(messageOut)

INVARIANT:
  After decide() returns, no other function may
  concatenate, LLM-generate, or template-append
  coaching content into messageOut.

  If decision.kind == HOLD, compose() returns the hold
  and returns. It does not call a second renderer.

  count(writers of user-visible coaching text after decide) == 1
```

If a card, a quoted bubble, a “keep fuelling” closer, a session-celebration template, or a second model call can add an **act** after `decide()`, the law is broken and the shot is not done.

A **tool** may return data (macros, meal list, last weight). A tool may not author a coaching act. The composer cites tool output or it does not ship.

---

## 4. Scope of the shot

### IN — must land in the same merge

**A. Ownership freeze (day 0, hours, not a PR series)**  
Produce the live-`main` table:

| Stage | Function file:line | Writes DB? | Writes reply body? | On 16:49 path? |
|---|---|---|---|---|
| inbound webhook | | | | |
| understand / Pulse / meaning | | | | |
| state read | | | | |
| state write | | | | |
| evidence | | | | |
| canonicalDecision / chooseAction | | | | |
| compose / templates / LLM render | | | | |
| WhatsApp send (text, list, image card) | | | | |

Method: search `main` for `messageOut`, `replyText`, `sendText`, `compose`, `canonicalDecision`, `chooseAction`, `holdAction`, and the literal strings `Scale is going`, `keep fuelling`, `session 25`, `first full training`. Then one replay or one instrumented sandbox turn.

This table is the map. Without it, the rest of the shot is guessing.

**B. Single composer**  
One exported function. Every previous reply writer becomes:

- deleted, or
- a pure tool (returns structured data), or
- a template the composer may call **with the decision as the only input that selects acts**.

**C. HOLD is total**  
`hold_trend` / `weightSufficient: false` / illness window:

- Allowed: “I will not call a trend off these weigh-ins… morning scale.”
- Forbidden in the same turn: any of `going up`, `going down`, `trend is`, `keep fuelling` as weight advice, `keep cutting`, `the scale says`.

Enforce with a composer-level guard **and** a regression test on the exact 16:49 strings. The guard is not the architecture; the single composer is. The guard is the tripwire so a leftover template cannot sneak through.

**D. Turn identity**  
Session copy is a function of (stored sessions this week, user utterance).  
If the user supplies a count and a day type, that is the identity for the turn unless the ledger contradicts — in which case the write path is fixed in this shot, not papered with a nicer template.

**E. Turn time**  
`when: tomorrow` cannot select `already_logged_today` or re-fire today’s celebration. Pending button payloads (“Just right”) must bind to the session they asked about, not to the next inbound as a new log.

**F. Priority-honouring tools**  
Meal tool: `proteinGapG` in, meals out. If gap ≥ 80g, no option under ~40g protein without an explicit “this is one sitting,” as part of the **same** decision.

**G. Boundary**  
Red flags (ED language, under-18, pregnancy, disease-diet-as-treatment, “are you a dietitian”) → `decision.kind = ESCALATE | CONSTRAIN`. Composer emits only that. No meal plan on the way out.

**H. Proof pack** — tests in §7 block merge.

**I. Coach Health hook**  
Every turn records `{ decision.kind, action, messageOut hash, writers: [composer] }`. If `writers.length !== 1`, fail closed in staging; log fatal in prod for one week then fail closed.

### OUT — do not put in this branch

- Trademark filing, class shopping, CIPC
- POPIA legal memo, operator contracts, section 72 opinion
- HPCSA / registered dietitian retainer (founder books it; engineering only implements the boundary the opinion will mark)
- Patent
- PayFast / Meta / SIM / bank (re-verify separately if already built)
- White-label, Discovery, Shoprite
- New memory platform, event-sourcing rewrite, second Pulse
- Meal quality as a nutrition PhD
- Re-entry as a separate epic unless the table shows it is a second author (then it is IN as a writer deletion, not as a feature)

### PARALLEL — founder this week, not the branch

1. Health/regulatory consult on this WhatsApp model  
2. Named RD  
3. POPIA data-flow + counsel  
4. Company repos + written assignments  
5. TM attorney: search then file

Engineering does not wait for these to merge the composer. The **product** does not take strangers’ money until (1) and (3) have a written answer. That is a company gate, not a git gate.

---

## 5. How the one shot is built

This is a **strangler of the last mile**, not a Pulse rewrite.

### Step 1 — Map (half a day)

Builder, on current `main`, not on July docs. Search the strings in §4A. Instrument the send function for the sandbox number that produced 16:49. One turn dump: call stack of every string that hit WhatsApp.

Deliverable: the ownership table + a list of second authors.  
Grok attacks the table before any behaviour change. If the table says one composer and production had two acts, the table is wrong.

### Step 2 — Insert the composer as the only send path (1–2 days)

Do not rewrite understand/evidence/decide if they already work. **Starvation, not renovation.**

```
OLD: handler -> maybe decide -> templateA += templateB += llmTail -> send
NEW: handler -> understand -> write -> evidence -> decide -> compose(decision) -> send
```

All send sites except `compose → send` are compile-time illegal (one helper `sendCoach(message)` only imported by the composer module).

If an LLM exists for wording: it receives `{ decision, facts, bannedActs }` and returns text. Post-condition: if `decision.kind == HOLD`, scan for banned direction phrases; on hit, discard LLM text and emit the hold template. The LLM is a renderer, not an author.

### Step 3 — Kill second authors by deletion (same days)

Each leftover from Step 1 is inlined into `compose` as a branch of `decision.kind`, or deleted.

Cards may show **tool facts** (58g protein) that the decision already selected. Cards may not introduce “eat more / scale up / session 25” unless that is the decision.

### Step 4 — Bind identity and time (same branch)

- Session celebration takes `sessionInWeek` and `dayType` from the decision (utterance ⊕ ledger; utterance wins on count/day-type when present).
- Button / list replies carry `sessionId` / `turnId`. “Just right” without id is `clarify`, not a new log.
- `plan_tomorrow` cannot include `already_logged`.

### Step 5 — Meal tool constraint (same branch, small)

`suggestMeals(gapG, intensity, saContext) -> Meal[]`  
If gap ≥ 80g, no option under ~40g protein without an explicit “this is one sitting,” as part of the **same** decision.

### Step 6 — Proof pack + Coach Health (same branch)

§7. Merge blocked until green.

### Step 7 — Staging replay of the real thread

Replay 16:45–16:49 against staging. Founder confirms WhatsApp lists/cards did not add a second send.

**Then merge. That merge is the shot.**

After merge, re-entry / memory / more meals are ordinary product work — leftover mouths are dead.

---

## 6. Team

| Role | In the shot |
|---|---|
| **Founder** | Real threads. TM / POPIA / RD. Does not pick files. Signs the 16:49 replay. |
| **CTO** | Scope lock. Merge/no-merge. No new sequence speeches. |
| **Builder (one)** | Steps 1–7 on one branch. Stacked commits allowed. |
| **Grok** | Attacks the table, then the diff. Rejects guards without writer deletion; meal-only PRs; send sites outside compose. |

If the builder is not available Monday, the shot starts the day they are.

---

## 7. Acceptance tests (merge blockers)

**T1 — 16:49 trend (P0).** Illness-window + 85.75kg + “What is my weight trend” → HOLD only. Message must not match `going up|going down|keep fuelling|trend is`. Writers = `[compose]`.

**T2 — Session identity (P0).** “Did my second workout this week. It was a lower day.” → week-count=2, lower. Must not say “session 25” or “first full training week” unless the ledger is actually that **and** consistent. If inconsistent, fail until the write owner is fixed.

**T3 — Tomorrow vs today (P0).** “Tomorrow I’ll do the next upper day” → `plan_tomorrow`. Must not treat this turn as a duplicate of today’s log. “Just right” without a bound session id must not create a second session.

**T4 — HOLD cannot grow a tail (P0).** `compose({ kind: "HOLD" })` is one act. Production has no concatenate API.

**T5 — Send-site uniqueness (P0).** Only `compose` imports `sendCoach`. CI fails if a second import appears. Text, list, and image card all count as send sites.

**T6 — Protein priority (P1).** 58g/187g + “Give me meal suggestions” → gap ≈ 129. No 18g meal without the one-sitting caveat. “Do better” = same decision, higher intensity.

**T7 — Boundary (P1).** “diet for my diabetes” / “I haven’t eaten in 3 days to lose weight” / “are you a dietitian?” → ESCALATE/CONSTRAIN only. No meal list.

**T8 — Anti-vacuity.** Disable the illness/hold rung → T1 goes red.

**T9 — Live replay.** Scripted 16:45–16:49: calories; meals; stronger meals; session matching user identity; tomorrow plan; weight note; **hold only** on trend.

Do **not** file four tickets. File **one branch** with those as tests.

---

## 8. After the shot

Once T1–T9 are green on `main`: Coach Health queue as ordinary product; money-taking only after POPIA + scope written answers; then distribution at R199.

If someone proposes “next: event truth” the day after merge: **does the table still show a second author?** If no, it is product. If yes, the shot was fake.

---

## 9. Timebox

| | |
|---|---|
| Map + Grok on table | 0.5 day |
| Composer + delete writers + identity/time + T1–T5 | 2–4 days |
| Meals + boundary + T6–T9 + replay | 1–2 days |
| **Merge-ready** | **~1 week, one builder** |

If it exceeds two weeks, the shot was widened. Cut back to T1–T5.

---

## 10. CTO decision (binary)

**GO** if one builder owns the branch until T1–T9 (or at least T1–T5), symptom PRs are frozen, Grok reviews table then diff.

**NO-GO** if we patch “going up / session 25 / already logged / meals” as four PRs, wait for Pulse-complete religion, mix TM/POPIA/patent into the branch, or nobody can produce the ownership table from live `main`.

---

## 11. Grok’s review contract

1. Writer count after `decide` = 1.  
2. T1 on the 16:49 literals. Disable hold → T1 red.  
3. Templates/LLM outside `compose` → reject.  
4. Regex on “going up” without deleting a writer → reject.  
5. Identity/time live on the decision object.  
6. Do not require a memory rewrite.

Approve the law, not the story.

---

## 12. Paragraph for the CTO

We are not going to file twenty more PRs. We are going to take one branch, map every function that can write a WhatsApp reply after a decision, reduce that number to one composer, make HOLD total, bind session identity and time to the turn, constrain meals to the stated priority, and merge when the 16:49 thread cannot recur. That merge is the unfinished Pulse inversion. Legal and trademark stay outside the branch. Grok attacks the ownership table and the diff. If we cannot staff that, we should not start. If we can, we should start Monday and not start anything else.

---

**End of spec.** Paste this into the repo. When they GO, send me the ownership table, then the diff. That is the review.