# Build queue

**Founder, 24 Sep night (`docs/ORDERS.md` §0): the product is the goal.**
- This queue is derived from `docs/COVERAGE.md`: live harm first, then the least complete row with the most tester impact.
- Every item names its coverage row.
- Nothing here starts a new foundation while an existing one sits unwired.
- **First in lane B:** wire the existing actions into the new core (#393). Then the gate grades the new core's proposed actions against the expected stored rows.

**CTO decision, 24 Sep 11:05: lane B is now the priority.** The remaining lane A items are pattern-patches on the old pipeline. Each fix spawns a new edge ("No thanks", then "Nope", then "Hayi"), because the old design reads messages by hand-written patterns. The new core fixes those by design. So: finish the harm PRs already in flight, then **all new build effort goes to lane B**. The old-pipeline items below become **gate cases the new core must pass**, not patches.

## Lane A: live billing harm, allowed despite the freeze (tonight, small PRs)

- [x] #315 (PR #383) Cancel menu "4 — Just cancel" sends a shopping list and the subscription stays active: the client is still billed
- [x] #306 (PR #386) A minor stopped by the age gate keeps an active paid subscription
- [x] #303 (PR #384) Terms still promise a 7-day trial: make the copy match reality (no trial; guarantee wording as implemented)
- [x] #328 (PR #385) 14-day money-back guarantee, implemented end to end

## Lane B: the new core (top priority). Two parallel worktrees: B1 (gate, then Coach Health) and B2 (client record, then understanding and composer)

Order, and what "done" means today:
- [ ] #368 Replay gate hardening (Codex @ d4ddc3d on #298): check keys bound to full definitions and erasure of chat_history are done on #298 (dbbd9db); ITN and opt-out send are covered by the DB suite; still open: held-out grading in trusted base code
- [x] #270 Replay gate green, baseline recorded on main (PR #298): scores the 8 journeys, never-see, reply time, cost; the new coach in shadow beside the old path. **Unblocked 11:05 (key fixed).** First live run green: main's journeys 7 / 7.2 / 6.2 / **4.0** / 6.5 / 8 / 5.5 / 7.9, R0.009 per message, 2.3 s mean reply. Merged 14:04 (#298). Start with the audit's 24 real failures plus every case below; add real tester threads when read-only DB access exists.
- [x] #334 Delete dead code (PR #352): −6,700 lines, 15 never-scheduled jobs, Replit scaffolding; modules back to 234
- [ ] #271 (PR #356 merged; open until the gate shows the Comrades/knee facts surviving six turns, which needs #359) One record of the client: their words exactly as sent, and typed facts linked to them (knee, Comrades, pregnancy). Retention and erasure designed first. No model call of its own: facts come from #272's understanding call. Includes #323 (normaliser can never add facts).
- [x] #369 Link every piece of advice to what happened next (outcome data): first cut #377 (outcome by delivered move)
- [ ] #272 (PR #359 merged, shadow; switch per family after 3 gate runs) One understanding step: the AI reads each message once and writes what it means (intent, facts, corrections); code validates before saving. Replaces the ~440 patterns and the classifier call. Runs **in shadow** against the gate.
- [ ] #272 One writer, one sender: the composer writes every reply from the record. Switch one message family at a time; delete that family's old handlers in the same PR (mouth ratchet enforces it). With #320 (no prompt slice) and #322 (stored conversation state).
- [ ] #319 Every proactive send through the same writer and sender
- [ ] #293 Coach Health scores every live turn, daily tester digest
- [ ] #330 Real voice-note path in the gate
- [ ] #273 Carry C18's tests into the gate, close #260
- [ ] #342 Backups: test-restore, failure alerts, POPIA window
- [ ] #343 One schema system, not two
- [ ] #331 Archive contradicting docs

## Lane A: finish what's in flight, then stop

- [x] #263 Payments (#277)
- [x] #266 Pregnancy and disordered eating (#283)
- [x] #265 Opt-out (#285)
- [x] #268 Calorie floors (#304)
- [x] #264 Meal decline (#282)
- [x] #275 Nags and invented facts (#290)
- [x] #267 Age gate (#305)
- [x] #269 POPIA deletion (#307)
- [x] #321 Scope in code (#345)
- [x] #333 CI timeout (closed: superseded by #337, the 6-way split, merged)
- [x] #339 Patch 3 high-severity dependency vulnerabilities (security: allowed despite the freeze) (#374)
- [x] #340 AI spend cap fails open (security/cost: allowed despite the freeze) (#367)
- [x] #341 Delivery-status webhook fails closed (security: allowed despite the freeze) (#372)

## Gate cases for the new core (not patched on the old pipeline)

The new core must pass each of these on the gate before its message family switches:
#353 auxiliary-first medicine asks · #354 a coaching word vetoing an explicit off-domain ask · #286 opt-out inside a life-context message · #324 multi-day logs · #325 post-midnight day · #326 same meal, same calories, and corrections · #292 and #300 correction wording · #310 portion sizes · #315 cancel menu "4" answered with a shopping list.

## Parked until the core switches

#327 evening template (needs a Meta-approved template; founder task) · #328 14-day refund · #329 nutrition-direction review · pricing (founder: R199–R249).
