# Build queue

**CTO decision, 24 Sep 11:05: lane B is now the priority.** The remaining lane A items are pattern-patches on the old pipeline. Each fix spawns a new edge ("No thanks", then "Nope", then "Hayi"), because the old design reads messages by hand-written patterns. The new core fixes those by design. So: finish the harm PRs already in flight, then **all new build effort goes to lane B**. The old-pipeline items below become **gate cases the new core must pass**, not patches.

## Lane B: the new core (top priority). Two parallel worktrees: B1 (gate, then Coach Health) and B2 (client record, then understanding and composer)

Order, and what "done" means today:
- [ ] #270 Replay gate green, baseline recorded on main (PR #298): scores the 8 journeys, never-see, reply time, cost; the new coach in shadow beside the old path. **Blocked on `AI_INTEGRATIONS_OPENAI_API_KEY` (401).** Needs the `OPENAI_API_KEY` repo secret for the judge. Start with the audit's 24 real failures plus every case below; add real tester threads when read-only DB access exists.
- [ ] #334 Delete dead code (PR #352): −7,000 lines, 15 never-scheduled jobs, Replit scaffolding; modules back to 234
- [ ] #271 (PR #356) One record of the client: their words exactly as sent, and typed facts linked to them (knee, Comrades, pregnancy). Retention and erasure designed first. Includes #323 (normaliser can never add facts).
- [ ] #272 (PR #359, draft, shadow) One understanding step: the AI reads each message once and writes what it means (intent, facts, corrections); code validates before saving. Replaces the ~440 patterns and the classifier call. Runs **in shadow** against the gate.
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
- [ ] #264 Meal decline (PR #282), merge when green
- [x] #275 Nags and invented facts (#290)
- [ ] #267 Age gate (PR #305), merge when green
- [x] #269 POPIA deletion (#307)
- [ ] #321 Scope in code (PR #345): the model's NO declines; an outage does not refuse a client (Codex @ c4ca8df). Merges on green
- [x] #333 CI timeout (closed: superseded by #337, the 6-way split, merged)
- [ ] #339 Patch 3 high-severity dependency vulnerabilities (security: allowed despite the freeze)
- [ ] #340 AI spend cap fails open (security/cost: allowed despite the freeze)
- [ ] #341 Delivery-status webhook fails closed (security: allowed despite the freeze)

## Gate cases for the new core (not patched on the old pipeline)

The new core must pass each of these on the gate before its message family switches:
#353 auxiliary-first medicine asks · #354 a coaching word vetoing an explicit off-domain ask · #286 opt-out inside a life-context message · #324 multi-day logs · #325 post-midnight day · #326 same meal, same calories, and corrections · #292 and #300 correction wording · #310 portion sizes · #315 cancel menu "4" answered with a shopping list.

## Parked until the core switches

#327 evening template (needs a Meta-approved template; founder task) · #328 14-day refund · #329 nutrition-direction review · pricing (founder: R199–R249).
