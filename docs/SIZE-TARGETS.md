# Honest size targets (CTO decision, 1 Oct): FIRST CHECKPOINT

The board says "server ≤25,000 lines". That target can't be reached as written.

- The old delete list held 39 files, 21,725 lines.
- The server is 73,900 lines.
- **Deleting every listed file would still leave about 52,000.**

And not every listed file should go. The design keeps the old modules that save data, because they work and the new core calls them. This sorts the list and proposes targets that can be hit.

## The sort (`docs/delete-list.txt` now lists only whole-file deletions)

| Group | Files | Lines today | What happens |
|---|---|---|---|
| **Delete whole** | gpt-block, meaning-engine, perception, coach-brain, client-snapshot, agents, advice-commands, food-commands, numbers-literacy, normalizer-fidelity, drill-cases; one-action (after B1–B6 decide in the new core); memory, intelligence/profile (D2: into the client record); machine-coach + equipment-vision (A9, frozen; CTO 1 Oct) | 6,886 | Gone by D9. This is what the board now counts. |
| **Partial** | early-commands, misc-commands, lifecycle, understanding/live, brain/reply-verifier | 6,421 | Writers stay (goal change, profile updates, `closeCoachingTurn`, `stripModelDirectives`, safety verifiers). Estimate: about half goes, roughly 3,200. |
| **Keep as savers / floors** | food-context, food-log-mgmt, sick-flow, meal-repeat, backfill, macro-card-attach, unlogged-notice, portion-memory, outbound-authority, proactive-decision, health-state, held-constraints, life-context, reply-hygiene, messy-intake, reentry, reply-contract, self-check, verifiers/meal-verifier | 8,469 | Stay. The new core calls them for writes, cards, honesty notices and send floors. |

**The meal-estimate checker stays, because it is live.** When a client logs a food the scanner doesn't know, `food-context.ts` (lines 1257 and 1347) calls `gptFoodFallback` in `gpt.ts`. That runs `verifyMealEstimate` (line 811), which corrects the model's estimate before it's written to the ledger. It protects saved data, not reply wording.

## Targets (CTO decision, 1 Oct)

| | Today | First checkpoint | How |
|---|---|---|---|
| Delete-list files alive | 16 | **0** | One per switch PR, as now. |
| Server lines | 73,900 | **< 64,500** | The whole-file deletions plus about half the partials. |
| Test lines | 58,257 | **Set by what's deleted** | Each deletion PR removes the harnesses of the code it deletes and records the lines here. |

**64,500 is a waypoint, not the goal.** Once the scheduled messages (B1–B6) have switched, a second pass goes line by line through the rest. That covers old message copy, the scripted onboarding, the admin pages marked "not needed now", `routes.ts` and the media handler, and sets the real target from that list.

`script/cto-watch.py` shows these numbers in place of "≤25,000 / ≤20,000".
