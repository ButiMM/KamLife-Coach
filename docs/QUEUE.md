# Build queue

Two lanes. Claude Code runs both: lane A in its main session, lane B in a parallel worktree/subagent. In each lane, take the first unchecked item, one PR, tick after merge, take the next. Every finding from the reviews is in `docs/FINDINGS.md`; nothing is dropped. Maintained by the CTO.

## Lane A: harm and what testers see

- [x] #263 Payments (PR #277, merged)
- [x] #266 Pregnancy and disordered eating (PR #283, merged)
- [ ] #264 Meal decline (PR #282: tests running, merge when green)
- [ ] #265 Opt-out (PR #285: tests running, merge when green)
- [ ] #275 Nags and invented facts (PR #290: tests running, merge when green)
- [ ] #267 Age gate (PR #305: tests running, merge when green)
- [ ] #268 Calorie floors (PR #304: tests running, merge when green)
- [ ] #269 POPIA deletion (PR #307: tests running, merge when green)
- [ ] #321 Scope in code, fail closed (Meta risk)
- [ ] #286 Opt-out inside a life-context message
- [ ] #324 Multi-day logs collapse into one row
- [ ] #325 Post-midnight day boundary, one helper
- [ ] #326 Same meal, same calories; corrections that work
- [ ] #292 Multi-word negated food in a correction
- [ ] #300 Explicitly named older meal in a correction
- [ ] #328 14-day money-back guarantee
- [ ] #327 Evening coaching outside 24h
- [ ] #329 Nutrition direction from code

## Lane B: the new core (kills the mouths, adds memory)

- [ ] #270 Replay gate, baseline on main (PR #298: fix failing checks)
- [ ] #293 Coach Health scores every live turn, daily tester digest
- [ ] #271 Event record and fact store (with #323: the client's words stored untouched)
- [ ] #323 Normaliser can never add facts
- [ ] #272 Understanding step and one composer, shadow, then switch family by family (with #320 prompt, #322 stored state)
- [ ] #320 Coach prompt without the 20k slice
- [ ] #322 Conversation state survives redeploys
- [ ] #319 Every proactive send through one owner
- [ ] #330 Real voice-note path in the gate
- [ ] #273 Carry C18's tests into the gate, close #260
- [ ] #331 Archive contradicting docs

Lane B owns new files (`script/replay*`, `server/core/`, new migrations) and touches `server/routes.ts` only in #272's switch PRs.
