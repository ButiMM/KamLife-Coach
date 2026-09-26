# ORDERS — Coach K

**Owner:** CTO (Claude, chat). **Version 3, 23 September 2026.** Incorporates the Grok review, the Claude Code audit (`AUDIT.md`) and the outgoing CTO's handover.

Every builder and reviewer reads this before starting work. It overrides every earlier plan, programme doc, cut list and status file (including C18–C20, `OUTSTANDING.md`, `LAUNCH_BLOCKERS.md`, `DEFECTS.md` and the `docs/CTO-*` files). When anything disagrees with this file, this file wins.

**Pull requests and issues are the mailbox.** Tasks are GitHub issues. Work is a pull request that closes one. Nobody relays work through chat or screenshots.

---

## 0. The product is the goal (founder, 24 Sep night)

This section outranks the rest of this file. It exists because a broad product was built in a narrow corridor for months: every plan started from what broke, the gate became the goal, reviews went deeper into the same spot, and foundations were started and then replaced instead of finished. The founder had to find it. That must not happen again.

1. **The goal is the whole product.** `docs/TESTER-EXPERIENCE.md` defines it. `docs/COVERAGE.md` maps it, one row per capability (inbound, proactive, money and trust, foundation). Gate cases, harms and attacks are how a row is proven. They are not the goal.
2. **Work order comes from the map.** Live harm to clients, money or data still comes first. After that, the next task is the least complete row with the most tester impact, not the last failure. `docs/QUEUE.md` is derived from the rows.
3. **Finish before you start.** Existing code for the same job is either listed in `docs/COMPONENTS.md` or found by searching the repo. While it is unfinished, nobody starts a new foundation: no new module under `server/core/`, store, table, prompt pipeline or scheduler. A PR states what it reuses or finishes in a `Reuses:` line. A new foundation needs the CTO's written reason why the existing one cannot be finished, on the PR.
4. **Every PR names its row:** `Coverage row: A1` (several are fine; docs and ops PRs use a D row). The watch flags a PR without one.
5. **Reviews and attacks feed the map; they never start a new plan.** Every finding maps to a row. A finding that would need a new foundation names the existing one it replaces and why that one can't be finished. Otherwise it is a task on that row.
6. **Width check, weekly.** The sweep (`docs/CTO-SWEEP.md` §0) reports:
   - which rows moved toward complete;
   - which rows still have zero gate cases;
   - which foundations are started but unwired.

   If a week passes with no row reaching complete, stop and reassess, as in §5.
7. **The founder does not audit this.** If the founder has to point out a gap across the product, the CTO and the builder have failed this section, and the fix is written into this section.

## 1. The decision

Keep the plumbing. Replace the coaching core behind it.

**Keep:**
- WhatsApp transport and signature checks
- the meal, step, workout and weight ledgers
- day-ledger arithmetic
- PayFast ITN handling
- crisis detection
- the outbound send path

**Replace:** how Coach K remembers, understands and speaks. Today 29 message-deciders and hundreds of text-writing sites compete for each turn, and client facts are mostly never stored. The Comrades/knee replay proved it: the facts were absent from storage six messages later. Consolidating the existing router was tried (issue #63, 77 PRs) and did not change what testers experience.

"One mouth" means one authority over each customer-facing turn. It does not mean one API call. Deterministic safety, billing, consent, opt-out and arithmetic stay outside generative discretion.

**Capabilities that must survive the switch:** food decisions and swaps, messy retrospective logging, voice notes, adaptive training, proactive accountability.

## 1b. The product

`docs/TESTER-EXPERIENCE.md` defines what testers experience when Coach K is done. It is the gate's journey list and the target for lane B.

## 2. Release standard

A turn is correct only when all four hold:
1. the right fact is stored, and traceable to what the client said
2. the right decision is made
3. the final WhatsApp body, as sent, is useful and true
4. the delivery status is truthful

These must hold on later turns and days too. A green handler test is not this standard.

## 3. Hard invariants (release-stopping)

Any of these failing blocks release, whatever the average score:
- **Payments:** cancellation must not leave the client charged or reactivated.
- **Deletion:** POPIA deletion must leave no retained personal data outside an expressly documented exception.
- **Opt-out:** must be honoured at the send boundary, on every send path.
- **Safety:** pregnancy, disordered-eating and minor-sensitive turns get the safe response.
- **No false writes:** no stored fact the client didn't give, and no deleted fact the client didn't retract.
- **No invented facts** in the reply.

## 4. Order of work

### Step 1 — Stop present harm (issues labelled `harm`)
Bounded fixes, one PR each:
- payments
- a meal decline deleting food
- opt-out
- pregnancy and purging routing
- age gate
- calorie floors
- POPIA deletion

For each: reproduce the failure first as a failing test, then show the changed stored state and final outbound outcome.

**No new testers and no paid Coach K signups until every `harm` issue is closed.**

### Step 2 — The customer replay gate
- **Cases:** the known real failures (`AUDIT.md`, issue #119's normaliser gap), then consented, de-identified tester turns.
- **Real conditions:** runs the production-shaped path with the live model and production-relevant flags.
- **Graded on:** persisted rows, sourced facts, the post-transport WhatsApp body, safety, delivery and follow-on turns.
- **Judge:** an OpenAI model, a different family from the builder (see §6).
- **Recorded per run:** model version, prompt version, corpus version, and before/after scores.
- **Held-out set:** a portion of cases the builders never see, so they can't tune to them.
- **Baseline:** recorded on current `main` before any replacement is graded.
- **Storage:** raw tester conversations never go into Git. The corpus lives in private storage, de-identified.

### Step 3 — One attributable client state
- **Event record:** keeps the client's original message distinct from transcription or normalisation.
- **Typed facts:** goal, injury, constraint, schedule, preference, life event. Each has a source message and time scope.
- **Corrections supersede;** history is never silently changed.
- **Questions and quotes** are not recorded as facts.
- **Retention and verified POPIA erasure are designed before any backfill.** "Immutable" means protected from rewriting, not undeletable.
- **Existing ledgers stay** and remain the owners of their writes.

### Step 4 — Understanding and one composer
- **Understanding:** a structured step proposes intents, facts and uncertainty.
- **Writes:** ledger owners validate and commit them.
- **Decision:** one authority chooses what matters now.
- **Reply:** one composer writes it.
- **On model failure,** the bot does not manufacture a confident coaching action.

### Step 5 — Shadow, switch, remove
- **Shadow is read-only for coaching state.** The new core runs beside the old one on the same raw input and the same pre-turn client state. It never writes the `users` row or the ledgers, and never sends. **One exception, deliberately:** the client record (`core/client-record.ts`) may store what the client said and the facts in it, through its own validation. That is the one memory being kept, not a second one; the old stores are retired by #414 and the switch PRs. (Clarified after the Grok review, 25 Sep.)
- **If understanding fails, the new core composes nothing** (#421). No confident move without a reading of the turn.
- **Instrumented:** which path claimed the turn, what facts were read, what would have been written, and the body that would have been sent.
- **Switching:** a bounded message family switches only when it beats the old path on the gate with no new hard failure.
- **Every switch names:** the old path deleted in the same PR, and the rollback condition.
- **No permanent dual system.**

## 4b. The mouth ratchet

The failure behind every rebuild was mouths: many places that can claim a turn and speak before the coach. `script/mouth-count.py` counts them, and `docs/mouths.json` holds the current numbers. The `mouth-ratchet` check fails any PR that increases a count. A PR that removes mouths lowers the numbers in `docs/mouths.json` in the same PR. The counts can only go down. Every #272 switch PR must lower `routeMessage_exits_before_engine`.

## 4c. Old-pipeline freeze (24 Sep)

No new fixes on the old pattern-matching pipeline except for live harm to clients, money or data. Everything else is a gate case the new core must pass. Every pattern patch adds another mouth's worth of edges; the core removes them.

## 4d. Replace, don't add (24 Sep)

Every `[core]` PR says what it **retires**: stores, handlers, AI calls, prompt text. It names the switch PR that deletes them. A new store beside the old ones, with nothing retired, is a layer, and layers are how four rebuilds failed. The watch flags any `[core]` PR that adds a table without a `Retires:` section. Code size is tracked on #280 against a target of 25,000 server lines or fewer.

## 4e. Components (24 Sep)

`docs/COMPONENTS.md` decides keep, reuse, replace or delete for every part of the codebase. The new core **calls** existing tools (food data, targets, day maths, programmes, vision, voice) and never rebuilds them. Replaced components are deleted in their switch PR. `docs/delete-list.txt` (41 files, 23,083 lines) must reach zero.

## 5. Stopping rule

If, after the gate baseline and shadow core are running, the shadow core does not beat the old path on the memory and safety cases within five working days, stop and reassess the design. Don't keep cutting. This is the rule #63 lacked.

## 6. Roles

**Grok (independent reviewer, fixed rhythm):** a daily product review at ~07:00, plus a switch review whenever a `switch` PR opens. Prompts and rhythm are in `docs/GROK.md`. The CTO triages every review into the three piles and files the gaps onto `COVERAGE.md` rows.

**Lean verification (founder decision, 25 Sep): the builder's capacity comes first.**
- **Every PR:** tests, the mouth ratchet, and, on `ready`/`switch`/`gate` PRs, the live replay gate. The gate's judge is an OpenAI model grading real tester journeys, which makes it independent of the Claude builder. It is the main check.
- **Attacks only where a mistake reaches people or money:** `switch` PRs (testers meet the new coach) and `[harm]` PRs (payments, safety, data). **The CTO does these attacks.** Codex joins when it has capacity. No separate attacker session runs by default (`docs/ATTACKER.md` stays available).
- **Real testers are the final attacker.** After each switch, the founder and testers use the bot; one-tap 👎 (#360) turns a bad reply into a gate case.


| Who | Owns | Doesn't |
|---|---|---|
| **Claude Code** | All building: every `harm` and `core` issue, the merge and the deploy path. | Review its own PRs as independent. Merge a PR before Codex has attacked it. |
| **Codex** | Attack only. On every PR: take the exact head SHA, hit it with adversarial, realistic South African client messages (code-switching, voice transcripts, messy multi-day logs, refusals, corrections, safety and payment edge cases), and post the first divergence as a PR comment with a failing assertion. | Build, fix, or approve its own findings as resolved. |
| **CTO (Claude, chat)** | These orders, the issue queue, repo settings, and verifying claims against the code. | Write product code. |
| **Founder** | Product, safety-policy and commercial decisions. | Poll CI, merge PRs, or relay messages. |

**Gate judge:** an OpenAI model, a different model family from the builder, called with the existing OpenAI key. The judge never sees builder reasoning, only the input, the stored state and the final WhatsApp body.

**Quality bar under auto-merge (24 Sep):** speed never lowers the bar. Every PR needs green tests (all six database shards) and a passing mouth ratchet. REGRESSION findings block. Hard invariants (§3) block. EDGE findings aren't dropped: each becomes an issue **and a gate case the new core must pass before its message family switches**. A PR labelled `switch`, which moves real testers onto the new coach, never merges on a timeout: it needs an actual Codex attack, answered, and a green replay gate showing it beats the old code.

**If Codex is out of usage limits when a `switch` PR is ready (24 Sep evening):** the CTO performs the attack instead: a diff review against `docs/COMPONENTS.md` and `TESTER-EXPERIENCE.md`, plus the 3-run gate numbers, posted as `ATTACK @ <sha> (CTO)`. A switch never waits a night on a usage limit, and never merges without an attack. Codex attacks the merged version when its limits reset.

**FULL PRODUCT, IN PARALLEL: no MVP cut (founder decision, 25 Sep; replaces the launch-scope cut from earlier today).**
Every one of the rows in `docs/COVERAGE.md` goes to the new coach under the switch standard. Nothing is parked "for after launch": parked work never gets built. Speed comes from **three builder lanes working at the same time**, not from dropping scope.

| Lane | Owns (COVERAGE rows) | Main files |
|---|---|---|
| **Lane 1: talk and do** | Wave 1 (A10, A11, A13, A16, A17), then wave 2 (A1, A2, A5, A6, A7 in words, A8, A12, A14, A15, A19) | `server/core/`, `understanding/executor.ts`, `understanding/actions.ts` |
| **Lane 2: speak first** | Wave 4 (B1-B12): every message the coach sends first, through one writer and one sender (#319), templates and the 24 h window | `server/scheduler/`, `core/` proactive entry |
| **Lane 3: see and hear, money and front door, foundation** | Wave 3 (A3, A4, A7 photos, A9, A18), wave 5 (C1-C8), wave 6 (D2-D12), plus the scoreboard (#433) and live scoring (#293) | media, onboarding, payments, schema, backups, Coach Health |

- Each lane runs its rows in wave order and switches each row as soon as it meets the standard.
- A switch PR may delete `routeMessage` exits for **its own rows only**, and merges `main` in right before merging.
- **Measurement is width-first for everyone:** every row has cases and a score by Sun 27 Sep (#433).
- If only one builder session is running (the default while the founder's Claude capacity is limited), it works lane 1, then 2, then 3, in that order, and never parks a row as "later".
- **SHIP AS FINISHED (founder decision, 26 Sep): this replaces the founder-first and wait-for-attack rules for switches.** Testers are testers, not customers. Every switch goes **on for everyone** in the PR that proves it: gate green on the switched path, the reach check, zero hard failures, and **the old code deleted in the same PR**. It merges automatically. The CTO attacks it **after** merge; any finding goes to the top of the queue. `off` stays the emergency rollback. A short "what's new" note goes to testers automatically after each switch, with no approval step.
- ~~Overnight and whenever the CTO isn't around to attack:~~ (superseded) a `switch` PR for a new row ships **founder-only** (its flag defaults to the founder's number, label `founder-only`) and may merge on a green gate plus the reach check. The CTO attacks it on the next session, and a small follow-up PR turns it on for everyone, with the deletion. Work never stops for an attack.
- **Wave 1 goes straight to everyone (founder decision, 25 Sep)**, with its intercepting handlers deleted in the same PR and the gate run on that exact change. Founder-first (#438) remains available for riskier later rows (money, onboarding).

**Reuse is mandatory (25 Sep):** the new coach is a thin brain (`server/core/`, 359 lines today) on top of the existing product. About 51,000 of the 74,000 server lines are kept or reused (`docs/COMPONENTS.md` §1-2); about 22,000 are replaced. Every switch PR must show which existing tools its rows call (food data, targets, day ledger, meal plans, programmes, actions and executor, outcomes, safety and medication rules). A new module that re-implements any of them is rejected. The watch shows how many tools the new coach reuses.

**Measure width-first, build wave by wave (CTO, 25 Sep):** every `COVERAGE.md` row gets gate cases and a score within 48 hours, so no part of the product is invisible (see the full-product scoreboard issue). Switching still goes one wave at a time. Live scoring of real conversations (#293) comes straight after the wave-1 switch.

**Focus until the first switch (CTO, after the Grok review, 25 Sep):** wave 1 only. Finish #414, #421, #422, then the wave-1 head-to-head and **one** switch PR that deletes wave 1's old speakers. Already-built wave-2 PRs may merge, but no new wave-2 work starts until wave 1 has switched.

**Before the first switch (CTO, 25 Sep):** existing clients' history must be in the client record (#414). Otherwise the switch itself makes the coach forget long-time testers.

**When the gate can decide a switch (24 Sep evening):** single-case scores move by about ±3 between runs of the same code. So a `switch` PR needs **(a) at least 5 cases for its journey, (b) the average of 3 gate runs, new coach against old code on the same cases, (c) the new coach ahead on that average, and (d) zero hard-invariant failures in any run.** Cost and reply time are reported (baseline on main: R0.009 a message, 2.3 s).

**Tester-visible rule:** every PR description opens with one line, "What testers will notice:", in plain language. If the answer is nothing, it says why the PR is still needed today. Work is ordered so the changes testers feel most land first.

**Merge standard (how a PR finishes):** a PR merges when (1) the failure its issue describes is reproduced and fixed, (2) checks pass, and (3) nothing is worse than current `main` on a hard invariant. A Codex finding that is a new edge case, not a regression against `main`, becomes a follow-up issue at the top of `docs/QUEUE.md` and does not block the merge. After two attack rounds on one PR, all remaining non-regression findings become follow-ups. Better than `main` ships; perfect doesn't wait.

**Database suite:** runs on GitHub on every PR again (repo public since 2026-09-24, so minutes are free). Merge needs green GitHub checks.

**Merge rule:** a PR merges only when the gate passes, no hard invariant fails, and Codex's attack comment has been answered with either a fix or a stated reason it doesn't apply.

## 7. Frozen and closed

- **#260 (C18) is frozen.** Do not merge. Claude Code accounts for its real-Postgres journeys (as gate specs) and its migration before closing or superseding it.
- **#48, #51, #91, #97, #100, #119 are closed** as historical evidence, not a merge queue.
- **Branch `claude/whatsapp-coach-architecture-pj5gc0`** is 0 commits ahead of `main`. Nothing unique on it.
- **Uncommitted scratch checkouts** (including a `review-cut4` checkout with a truncated `server/foods.ts`) are not release work. Never copy from them.

## 8. Status

After every merged PR, append one line to `docs/STATUS.md`:

```
HH:MM · agent · PR # · what changed · gate before → after · +lines / −lines
```

Never write "fixed" or "done" without a gate result behind it.
