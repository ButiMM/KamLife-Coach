# ORDERS — Coach K

**Owner:** CTO (Claude, chat). **Version 3, 23 September 2026.** Incorporates the Grok review, the Claude Code audit (`AUDIT.md`) and the outgoing CTO's handover.

Every builder and reviewer reads this before starting work. It overrides every earlier plan, programme doc, cut list and status file (including C18–C20, `OUTSTANDING.md`, `LAUNCH_BLOCKERS.md`, `DEFECTS.md` and the `docs/CTO-*` files). When anything disagrees with this file, this file wins.

**Pull requests and issues are the mailbox.** Tasks are GitHub issues. Work is a pull request that closes one. Nobody relays work through chat or screenshots.

---

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
- **Shadow is read-only.** The new core runs beside the old one on the same raw input and the same pre-turn client state. It never writes client state and never sends.
- **Instrumented:** which path claimed the turn, what facts were read, what would have been written, and the body that would have been sent.
- **Switching:** a bounded message family switches only when it beats the old path on the gate with no new hard failure.
- **Every switch names:** the old path deleted in the same PR, and the rollback condition.
- **No permanent dual system.**

## 5. Stopping rule

If, after the gate baseline and shadow core are running, the shadow core does not beat the old path on the memory and safety cases within five working days, stop and reassess the design. Don't keep cutting. This is the rule #63 lacked.

## 6. Roles

| Who | Owns | Doesn't |
|---|---|---|
| **Claude Code** | All building: every `harm` and `core` issue, the merge and the deploy path. | Review its own PRs as independent. Merge a PR before Codex has attacked it. |
| **Codex** | Attack only. On every PR: take the exact head SHA, hit it with adversarial, realistic South African client messages (code-switching, voice transcripts, messy multi-day logs, refusals, corrections, safety and payment edge cases), and post the first divergence as a PR comment with a failing assertion. | Build, fix, or approve its own findings as resolved. |
| **CTO (Claude, chat)** | These orders, the issue queue, repo settings, and verifying claims against the code. | Write product code. |
| **Founder** | Product, safety-policy and commercial decisions. | Poll CI, merge PRs, or relay messages. |

**Gate judge:** an OpenAI model, a different model family from the builder, called with the existing OpenAI key. The judge never sees builder reasoning, only the input, the stored state and the final WhatsApp body.

**Tester-visible rule:** every PR description opens with one line, "What testers will notice:", in plain language. If the answer is nothing, it says why the PR is still needed today. Work is ordered so the changes testers feel most land first.

**Merge standard (how a PR finishes):** a PR merges when (1) the failure its issue describes is reproduced and fixed, (2) checks pass, and (3) nothing is worse than current `main` on a hard invariant. A Codex finding that is a new edge case, not a regression against `main`, becomes a follow-up issue at the top of `docs/QUEUE.md` and does not block the merge. After two attack rounds on one PR, all remaining non-regression findings become follow-ups. Better than `main` ships; perfect doesn't wait.

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
