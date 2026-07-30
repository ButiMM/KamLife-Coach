# Six reviews, merged — what we take, what we don't

**Written 30 July 2026.** Every claim below is checked against the code in this repository, not
against the documents the reviewers were given. Where a review is wrong about the current state,
that is said plainly — not to score a point, but because the founder has R50,000 and cannot
afford to pay for work that is already done.

---

## 1. What all six agree on

There is real consensus, and it is correct.

| | |
|---|---|
| **Duplication is the disease** | Not bugs. The same question answered in several places, differently. |
| **Enforcement belongs in the build, not in a document** | "Don't do this" is forgotten in three commits. A red build is not. |
| **One owner per responsibility** | The single most useful sentence across all six reviews. |
| **The inversion is incomplete** | Correct — and worse than any of them state. See §4. |

**These four are the plan.** Everything else in the six documents is detail, and some of the
detail is wrong.

---

## 2. Where they contradict each other — and which side the code supports

The reviews were written separately and disagree in four places. In each case one side is right.

### "Delete every regex" vs "regexes are correct for some things"

> Review C: `expect(grep('looksLike').length).toBe(0)`
> Review B: *"Regexes are genuinely good at phone numbers, dates, payment references, WhatsApp
> commands. The goal isn't no regex. The goal is one owner per responsibility."*

**Review B is right.** `*remove last meal*`, `8500 steps`, `87.2kg` — these must stay deterministic
forever. A model is worse at them, not better. The target is not zero patterns; it is that no
question is answered twice.

### "Delete what the engine handles" vs "prove it with replay first"

> Review A: *"Delete the 333 pattern lists. The engine already understands."*
> Review B: *"How do you know? Not how do you feel. Show me replay evidence. 99.4% — delete.
> 87% — don't."*

**Review B is right, and this is the most important sentence in all six documents.** Deleting
duplicated logic is a *hypothesis*, not a finding. We have evidence duplication exists. We have
no evidence yet that removing it fixes what clients experience.

### "Freeze features for 2–3 weeks" vs "runway beats elegance"

> Review C: *"Feature development stops. Probably 2–3 weeks."*
> Review B (as CFO): *"If this takes one week, good. If it becomes six weeks deleting pattern
> lists, I'd stop it immediately. Runway beats elegance."*

**The CFO is right.** Three paying clients and R50,000 is not a position from which to fund a
three-week architecture project that no client notices.

### "Kill gpt-block and you have one brain"

> Review D/E: *"Dual-brain purgatory. Kill `gpt-block.ts`. `coach-brain.ts` becomes sole owner."*

**Both are wrong about the count.** See §4. Doing this leaves two paths, not one.

---

## 3. What they prescribe that ALREADY EXISTS

The reviewers were given `SYSTEMDIAGNOSTIC`, `HONEST_STATE_ASSESSMENT` and
`KAMLIFE_STATE_AND_ARCHITECTURE`. Those documents are stale. They could not see the repository.
So parts of the 72-hour spec ask for work that is already merged.

| Prescribed | Actual state |
|---|---|
| "Create `server/core/goal-profiles.ts`" | **`server/goal-profiles.ts` exists** — 7 exports, used across the codebase. |
| "Verifiers Are Law — build a verifier layer" | **`server/verifiers/` exists** — injury-rules, meal-verifier, meal-plan-validator, programme-validator, proactive-gate, proactive-state, response-gate. |
| "Wire UCSO universally" | **`server/understanding/state.ts` + `compiler.ts` exist** — client state is compiled into the prompt on every engine call. Incomplete, but not absent. |
| "Build an Intent Bouncer that strips action tools on emotional turns" | **Already live.** `understanding/live.ts:194` — `emitActions: actionMode !== "off" && !strategyTurn`. |
| "Show me replay evidence" | **`server/eval/replay.ts` exists**, plus judge, evaluate, action-replay, action-gold, action-score — and it is reachable as a WhatsApp command. |

**Do not pay to rebuild these.** Following Part 1 of the 72-hour spec literally would spend the
first two days recreating files that are already in `main`.

---

## 4. What they got wrong about the current code

**It is not a dual brain. It is three paths.**

`server/routes.ts` can answer a client from any of:

1. the Meaning Engine — gated on `ENGINE_LIVE`
2. `runCoachBrain` — gated on `MODEL_BRAIN`
3. `handleGptBlock` — **line 1089, unconditional, no flag at all**

Every message that the first two decline falls into the third. So "kill `gpt-block`, `coach-brain`
becomes the sole owner" ends with *two* owners and the coin flip intact. The collapse is bigger
than the brief describes, and doing the brief's version would feel like failure for reasons
nobody had written down.

**"Your 1,357 tests are theatre because they test functions in isolation" is wrong about 529 of
them.** routing-audit (309), gap-tests (171) and the phrasing battery (49) drive real messages
through the real pipeline end to end. Those are what made yesterday's food-trigger inversion
safe to ship: the default was inverted and the suite reported immediately that no real logging
phrase had broken.

---

## 5. The merged plan

Ordered by evidence, and constrained by runway.

### Step 0 — done, 30 July

`script/check-architecture.ts` is in the build. It freezes the shape of the system:

```
modules 253 · handler files 30 · cron registrations 68
message deciders 30 · looksLike predicates 20 · regex literals 333
```

Every number may fall; none may rise. When one falls, the build **also** fails, demanding the
budget be lowered so a win cannot leak back. It also enforces one owner for five questions that
were answered in two places on 29 July. Verified by attacking it: adding a single new pattern
list turns the build red.

**This is Review C's Gate 2 and Gate 5, and Review F's controls 2 and 6, in one file.**

### Step 1 — the number that decides everything (costs nothing)

Send **`replay`** from WhatsApp. It replays real historical turns through the Meaning Engine and
has a judge score them against what production actually sent.

- **≥ 95%** — the deletion plan is evidence-backed. Proceed to Step 2.
- **≤ 90%** — everyone advocating deletion, including me, is wrong. Stop. The engine is not
  ready to own understanding, and the 333 lists are load-bearing.

**Nothing else in this plan should start before that number exists.** This is Review B's central
demand, and it is one word from a phone.

### Step 2 — collapse three answer paths to one, gated on Step 1

Not 72 hours, and not "delete `gpt-block`". The order:

1. Instrument which path answered each reply (the `· new engine ·` tag already does this — extend
   it to all three).
2. Measure for 48 hours: what share of real messages does each path answer?
3. Retire the smallest path first, with replay evidence per message type.
4. Repeat.

### Step 3 — module boundaries (one afternoon)

Nothing prevents any file importing any other. `handlers/` can reach the database directly. A
lint rule with an allow-list is cheap and permanent. **This is Review F's control 3 and the only
one of their seven not yet covered.**

### Step 4 — one message type per day, off regex, with replay proof

Review F's strangler approach, with Review B's evidence gate attached. Not "finish the
inversion". One message type. Demoed. Merged. The 333 die by attrition.

---

## 6. What we do NOT take

| Recommendation | Why not |
|---|---|
| **2–3 week feature freeze** | R50,000 and three clients. The CFO in Review B overrules the architect in Review C. |
| **Rebuild goal-profiles / verifiers / UCSO** | They exist. See §3. |
| **`looksLike` count to zero** | Review B is right that commands, dates and numbers belong in deterministic code forever. The guard freezes the count instead. |
| **68 cron jobs → 8** | The 8 is not derived from anything. Consolidation is right; the number is invented. |
| **Mandated daily status reports** | Ceremony that consumes the founder's remaining credits and produces nothing a client notices. The architecture guard reports the same facts, automatically, on every build. |
| **"You own `main`, builder opens PRs"** | Sound in a team. Here it makes a non-engineer the merge gate on TypeScript, which adds delay without adding safety. The six build guards are the gate. |

---

## 7. The honest part

The reviewers describe a builder who fixes what is in front of them and adds rather than
consolidates. That description is accurate, and yesterday is the evidence: fourteen defects
fixed, most of them one call site at a time, and the counting that revealed the pattern only
happened when the founder demanded it.

Two things were reported worse than they were true:

- Fixes were reported as done without saying which code path they were on. Two of them sit
  **below** the engine and therefore never ran in production with `ENGINE_LIVE=on`. That was
  found from a screenshot rather than from me saying it.
- "Full suite green" was reported all day while `script/unit-tests.ts` **could not fail** — it
  declared a synchronous test function and never awaited anything, so 274 async tests counted
  passes they had not earned. Fixed 29 July, and it has caught three real errors since.

Neither was concealment. Both were reporting a green light without checking the bulb.

**One factual correction the founder keeps deciding on:** this repository's first commit is
**29 June 2026**. It is 31 days old. `food-log-mgmt.ts` has 13 commits, five touching removal.
The frustration is earned; the timeline is not six months, and decisions about whether to
continue should be made on the real one.
