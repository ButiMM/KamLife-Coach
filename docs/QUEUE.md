# Build queue

Two lanes, so the core work starts now instead of after the harm fixes. Each Claude Code session works one lane: take its first unchecked item, one PR, tick it after merge, take the next. Lane A files and lane B files don't overlap. If you're not told a lane, you're lane A. Maintained by the CTO.

## Lane A: harm and visible fixes

- [x] #263 Payments: cancellation stops billing (PR #277, merged)
- [ ] #286 Opt-out inside a life-context message still opts out (follow-up from #285)
- [ ] #264 A meal decline must not delete logged food (PR #282: rebase, then merge; round-5 finding is #292)
- [ ] #292 Multi-word negated food in a correction (follow-up from #282)
- [ ] #266 Safety routing: pregnancy and disordered eating (PR #283: fix third-party regression first)
- [ ] #265 Opt-out honoured at the send boundary (PR #285: rebase on main, then merge)
- [ ] #275 Stop the nags and invented facts testers see every day
- [ ] #267 Age gate
- [ ] #268 Calorie floors
- [ ] #269 POPIA deletion actually deletes

## Lane B: the new core (a second Claude Code session)

- [ ] #270 Customer replay gate, baseline on main
- [ ] #293 Coach Health scores every live turn, daily tester digest
- [ ] #271 Event record and fact store
- [ ] #272 Understanding step and single composer, shadow, then switch
- [ ] #273 Account for #260 before closing it

Lane B owns new files only (`script/replay*`, `server/core/`, new migrations). It touches `server/routes.ts` only in #272's switch PR, after lane A is empty.
