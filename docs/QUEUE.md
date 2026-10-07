> **Frozen 7 Oct (founder + CTO, #391): not updated during the two-week freeze. Status lives on #391; the rules are the one page in `CLAUDE.md`.**

# Build queue

**Derived from `docs/COVERAGE.md` (the plan, `docs/ORDERS.md` §0).**
- Live harm to clients, money or data comes first.
- Then work goes wave by wave. Every item names its coverage row.
- Nothing starts a new foundation while an existing one sits unwired.
- **A row switches** when it has:
  - 5+ gate cases;
  - the new core ahead on a 3-run average;
  - zero hard failures;
  - a real attack;
  - its old files deleted in the same PR.

## Now (CTO brief, 24 Sep 20:35; none of this needs OpenAI credits)

1. [x] Rebuild this queue from the waves (this PR).
2. [x] #397 `/health` reports whether AI calls are succeeding (D8, D11) (#401, merged 25 Sep 06:12)
3. [x] Label #393 and #387 `ready`, so the gate grades them once credits are back (done 24 Sep 21:05)
4. [x] Wave-1 gate cases: A10, A11, A16 and A17 up to **5+ each** (#406, merged 25 Sep 07:08)
5. [x] The first `switch` PR: #454 merged 26 Sep (founder, reach 22/22). #460 turns wave 1 on for everyone with the deletions (ship as finished, #459)

## Open now (6 Oct; CTO order of 1 Oct, confirmed 5 Oct)

- [ ] #554 B7 follow-up: close a riding reminder by its own bubble's outcome (Codex @ 4f52e62 on #537)
- [ ] #537 A14 + B7: reminders in their own words; an undelivered reminder rides on the next reply
- [ ] #545 A19 + B2: the commitment loop (live read stores facts, migration 0021, two misses, weekly numbers)
- [ ] #552 B3 + B5 + B6: weigh-in, new phase and hello after silence in the new coach's words
- [ ] #550 A3: a food photo's meal in the new coach's words
- [ ] #551 D9: equipment-vision, machine-coach and home-workout deleted
- [ ] #553 D2: the vector memory store deleted
- [ ] A18 non-English gate case per Promise row (waiting on the CTO's test-lines ruling, #391)
- [ ] A4 real voice notes in the gate (#330); D2 next stores (CIP, profile notes); D7 live scoring (#293)
- [ ] Wave-1 flag retired: `CORE_WAVE1` off-path removed; gpt-block, advice-commands, numbers-literacy deleted (CTO 6 Oct, CLAUDE.md rulings §6)
- [ ] Wave-2 A1/A2 flag retired from Thu 8 Oct; A8/A12 from Fri 9 Oct (same rule)
- [ ] D7 live signals, no model call, in the 18:00 digest (CTO 6 Oct ruling §5)
- (withdrawn 6 Oct) ~~CI-only `OPENAI_API_KEY`~~: no paid gate, ORDERS §0c

## Open now (26 Sep evening; the watch reads the `- [ ]` lines)

- [x] #496 A quote addressed to someone else ("told her, 'you sound suicidal'") is that person's crisis (C6) — #497
- [x] #342 Backups test-restored before they are published; deletion survives a restore (D4) — #494
- [x] #499 A deletion survives losing the live database too (D4, [harm]) — #500
- [x] #319 Lane 2, first steps: every scheduled message through one sender (B1–B12) — #501, #502, #503, #504
- [x] #506 Evidence admin view (D7, D8) — #513
- [x] #507 / #508 drafts signed off by the founder (30 Sep) — #511, #512
- [x] #511 decisions: one scheduled message a day and the weekly report scheduled (#517); monthly narrative retired (#519); photo/video beyond food frozen (no code)
- [x] Diet break never ended: targets restored (A12, [harm]) — #518
- [ ] #514 Consent and crisis wording (C6/C7, [harm]) — PR #522
- [x] #488 One paid WhatsApp message per reply (D8) — #492
- [x] #484 Twilio or Meta direct: numbers and a recommendation (D8) — #493
- [x] #480 A friend's crisis quoted by the client is answered as a helper (C6) — #481
- [x] #476 A crisis in isiZulu, Afrikaans, Sesotho or Setswana gets the crisis reply (C4) — PR #477
- [x] #456 The backfill no longer tells the new coach "life/work: office" or a withheld state (A13) — PR #475, blocks #460
- [x] #467 History learning once per client, ever (D11) — PR #472 (the judge-once half merged as #473)
- [x] #412 gpt-4o only for crisis and photos (D8) — PR #474
- [x] C7 "Can I speak to a real person?" answered honestly — PR #471
- [x] #460 Wave 1 deletions (A10, A11, A16, A17): the founder sets Railway `CORE_WAVE1=on`; the deletions merge 48 h later if clean (ORDERS §0c, no paid gate)
- [x] #455 Wave 2 A1, the new coach speaks after a logged meal — after #460 (wave order)
- [x] #466 Wave 2 A2, the new coach reads a meal correction — after #455
- [x] #309 SA-language refusals ("Hayi", "Aowa", "Cha") open a correction — gate case for the new core (A2)
- [x] #300 An explicitly named older meal in a correction — gate case (A2)
- [x] #292 A multi-word negated food is not written back — gate case (A2)
- [ ] #297 A reactive weigh-in ask is recorded only after delivery (B): moved to lane 2 (#489 closed: needs a per-turn key)

## Live harm (always first)

- [x] #395 (PR #398, Codex follow-ups #402) OpenAI out of credits: the founder is alerted, and clients get an honest line, not "30 seconds" forever (D11, C7)

## Before the first switch (blocking)

- [x] #414 Backfill the client record from the old stores (#426, merged 25 Sep 13:59: users profile only; the capped chat-history pass is still open on #414)
- [x] #421 No new-coach reply without understanding; #422 its numbers come from the day ledger (#444, merged 25 Sep 17:16)

## Wave 1: talk (reply only, no writes). The new core already does this

| Row | Capability | Gate cases today | Next |
|---|---|---|---|
| A10 | What to eat, swaps, grocery, restaurants | what-to-eat-tonight, no-fish-remembered (2) | +3 cases, then switch |
| A11 | Coaching talk: stress, shame, "I need more help" | shame-after-takeaway, stress-and-takeaways, need-more-help, antibiotics-train-control, cv-skipped-gym-control (5) | switch after the 3-run average |
| A16 | Stats, "how was my week" | how-was-my-week (1) | +4 cases; the week facts must reach the composer |
| A17 | Off-topic redirect | business-plan-for-gym, cv-skipped-gym-control (2) | +3 cases (scope floor stays in code) |
| A13 | Memory feeding all of the above (#271) | comrades-knee-memory, third-party-pregnancy, no-fish-remembered | #271 closes when the gate shows the facts surviving six turns |

## Wave 2: do (validated actions → `understanding/executor.ts` → graded on stored state)

- [x] #393 The new core proposes validated actions, in shadow (merged 25 Sep 08:23) (the foundation for this wave; runs in parallel with wave 1)
- [x] #399 The gate grades the new core's proposed actions against each case's expected actions (#399; food, slot, day and numbers checked since #403)
- [x] Missing action types: `CORRECT_MEAL` (A2), workout done (A8), `SET_GOAL` (A12) (#408, merged with #393; validated and recorded, not yet performed)
- Rows: A1, A2, A5, A6, A7 (words), A8, A12, A14, A15. Gate cases already written for A1/A2: #324 multi-day, #325 post-midnight, #326 same meal, #292/#300 corrections, #310 portions.

## Wave 3: see and hear

- Rows: A3, A4, A7 (photos), A9, A18. #330 real voice-note path in the gate. Every row gets at least one non-English case.

## Wave 4: speak first

- Rows: B1–B12. #319 every proactive send through the one writer and sender. #327 evening template (founder task: Meta approval).

## Wave 5: money and the front door

- Rows: C1, C2, C3, C8. C4–C7 stay floors in code throughout: #286 opt-out inside a life-context message, #353 medicine asks, #354 off-domain veto. #329 nutrition-direction review; pricing is the founder's call (R199–R249).

## Wave 6: foundation cleanup

- D2 the nine stores become one (each store is deleted in the switch PR that stops reading it)
- D3 #343 one schema system
- D4 #342 backups: test-restore, alerts, POPIA window
- D5 #331 archive contradicting docs
- D9 `docs/delete-list.txt` down to 0
- D10 founder-critical pages checked

## Alongside every wave

- D1 the mouth ratchet only goes down
- D6 gate integrity: #368 held-out grading in trusted base code; the held-out set is the CTO's; #273 C18's cases into the gate, close #260
- D7 #293 Coach Health scores every live turn and sends a daily digest
- D8 live cost and latency
- D11 the cost firewall (#394, #396, #395)

## Done (24 Sep)

Lane A harms: #263 · #264 · #265 · #266 · #267 · #268 · #269 · #275 · #303 · #306 · #315 · #321 · #328 · #339 · #340 · #341 · #378.
Lane B: #270 gate (#298) · #271 record (#356) · #272 shadow core (#359) · #334 dead code (#352) · #369 outcomes by move (#377) · #381 eleven gate cases · #389 per-case core column · #392 coverage map and ORDERS §0 · #394 waves and the cost firewall.
