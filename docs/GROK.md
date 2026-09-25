# Grok: the independent reviewer, on a fixed rhythm

Grok is a different AI family from the builder (Claude) and the gate's judge (OpenAI). It reads this public repo, but it can't post to GitHub. So the founder pastes a prompt from this file into Grok, then pastes Grok's answer to the CTO in chat. The CTO sorts every point into three piles: **confirms the plan** / **gap inside the plan** (goes onto a `COVERAGE.md` row and into the queue) / **direction change** (only with evidence that beats `ORDERS.md`).

**Rhythm: at most two pastes a day.**

| When | Review | Purpose |
|---|---|---|
| **Every morning, ~07:00** | Daily product review (below) | Is every part of the product moving forward, not just the current wave? What stalled overnight? |
| **When a `switch` PR opens** | Switch review (below) | An independent check before testers meet the new coach on that row (the CTO also attacks it) |

The CTO reminds the founder when a review is due. The founder doesn't need to track it.

---

## Prompt 1: daily product review (paste as-is)

> Review https://github.com/ButiMM/KamLife-Coach, the `main` branch as it is now. You're the independent reviewer. **Don't redesign, restart or propose a new architecture.** Judge progress against the plan and name what isn't moving.
>
> Read: `docs/TESTER-EXPERIENCE.md` (the product), `docs/COVERAGE.md` (every capability as a row, and the waves), `docs/ORDERS.md`, `docs/COMPONENTS.md`, `docs/QUEUE.md`, `docs/RISKS.md`, `docs/COSTS.md`, issue #280 (live numbers), and the PRs merged in the last 24 hours.
>
> Answer with evidence (file and line, PR or issue) for every claim:
> 1. **Movement:** a table of every `COVERAGE.md` row: status (switched / on track / at risk / not moving) and **what changed in the last 24 h**. Flag every row that didn't move and should have.
> 2. **Deletion:** did the mouth count, the delete-list count or code size go down? If a switch merged, did it delete that row's old code?
> 3. **Gate:** is the gate actually running and deciding? Anything merged without it?
> 4. **Layers:** anything merged in the last 24 h that added a second way of doing something that already exists?
> 5. **Width:** the biggest capability (from the tester's point of view) with no progress and no plan.
> 6. **Cost:** anything wasting money.
> 7. **Blind spots:** anything a strong CTO would worry about that isn't in `RISKS.md` or the open issues.
>
> Finish with **the five most important next steps within the current plan**, in order. No restarts.

## Prompt 2: switch review (paste when the CTO says a switch PR is open; fill in the number)

> Review pull request #___ in https://github.com/ButiMM/KamLife-Coach. It moves real testers onto the new coach for one or more rows of `docs/COVERAGE.md`. You're the independent reviewer. **Don't redesign.** Decide whether it's safe and complete to merge.
>
> Check, with evidence:
> 1. Does the diff **delete** the old code for those rows (per `docs/COMPONENTS.md` and `docs/delete-list.txt`), and lower `docs/mouths.json`? If any old path for these rows can still answer, name it.
> 2. Do the safety floors (crisis, pregnancy and eating disorders, minors, opt-out, scope) still run **before** the new coach?
> 3. Is it behind a flag with instant rollback?
> 4. Do the gate results on the PR meet the switch rule in `docs/ORDERS.md`: 5+ cases per row, the new coach ahead on the 3-run average, zero hard failures, and the held-out set included?
> 5. What would a real South African tester send, for these rows, that no case covers?
> 6. Verdict: **merge** / **merge after these fixes** / **don't merge**, with the reasons.
