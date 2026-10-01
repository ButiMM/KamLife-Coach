# Honest size targets (CTO order, 1 Oct): PROPOSAL

The board says "server ≤25,000 lines". That target can't be reached as written.

- The old delete list held 39 files, 21,725 lines.
- The server is 73,900 lines.
- **Deleting every listed file would still leave about 52,000.**

And not every listed file should go. The design keeps the old modules that save data, because they work and the new core calls them. This sorts the list and proposes targets that can be hit.

## The sort (`docs/delete-list.txt` now lists only whole-file deletions)

| Group | Files | Lines today | What happens |
|---|---|---|---|
| **Delete whole** | gpt-block, meaning-engine, perception, coach-brain, client-snapshot, agents, advice-commands, food-commands, numbers-literacy, normalizer-fidelity, drill-cases; one-action (after B1–B6 decide in the new core); memory, intelligence/profile (D2: into the client record) | 6,563 | Gone by D9. This is what the board now counts. |
| **Partial** | early-commands, misc-commands, lifecycle, understanding/live, brain/reply-verifier | 6,421 | Writers stay (goal change, profile updates, `closeCoachingTurn`, `stripModelDirectives`, safety verifiers). Estimate: about half goes, roughly 3,200. |
| **Keep as savers / floors** | food-context, food-log-mgmt, sick-flow, meal-repeat, backfill, macro-card-attach, unlogged-notice, portion-memory, outbound-authority, proactive-decision, health-state, held-constraints, life-context, reply-hygiene, messy-intake, reentry, reply-contract, self-check | 8,067 | Stay. The new core calls them for writes, cards, honesty notices and send floors. |
| **Founder decision** | machine-coach (A9 gym-machine photos, frozen), verifiers/meal-verifier (meal-estimate passes) | 674 | A live feature. Keep or delete is a product call. |

## Proposed targets

| | Today | After D9 (this list) | How |
|---|---|---|---|
| Delete-list files alive | 14 | **0** | One per switch PR, as now. |
| Server lines | 73,900 | **≤ 64,500** | About 6,600 whole files plus about 3,200 from partials (≈ 64,100). |
| Test lines | 58,257 | **≤ 50,000** | Each deletion takes its harnesses with it (the `test_lines` ratchet holds the rest). |

**What these targets don't cover:** code outside the list, such as `routes.ts` (1,200 lines), the old scheduler composers B1–B6 replace, the media handler (A3/A4) and onboarding.
- A second sweep after the B rows would set the next target from a measured list, not a guess.
- 25,000 would need the writers themselves rewritten. Nothing in the plan asks for that, and they work.

Once the CTO agrees, `script/cto-watch.py` swaps the "≤25,000 / ≤20,000" text for these numbers.
