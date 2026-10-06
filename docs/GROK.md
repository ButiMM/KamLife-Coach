# Grok: the independent attacker, on a fixed rhythm (CTO, 6 Oct)

Grok is a different AI family from the builder (Claude), the attacker session (Claude) and Codex (OpenAI). Its job is **attack, not design**: find where `main` or an open switch PR fails a real tester, with evidence.

**Route (no relay to the CTO):**
1. Grok reads this public repo.
2. The founder pastes Grok's answer, unedited, as a comment on **issue #558**.
3. The CTO reads #558 on every builder check and sorts each point into one of three piles:
   - **confirms the plan**;
   - **gap**: it goes onto a `COVERAGE.md` row and into the queue;
   - **direction change**: only with evidence that beats `ORDERS.md`.

Market and pricing questions belong to the market room (`docs/MARKET-ROOM.md`), not here.

**Rhythm: two pastes a day.**

| When | Prompt | Purpose |
|---|---|---|
| **Morning, ~08:00** | Prompt 1 (daily attack on `main`) | What broke, stalled or regressed in the last 24 h |
| **Afternoon, ~15:00** | Prompt 2 on the newest open `switch` PR (the list is on issue #280); if there's none, Prompt 1 again | An independent check before testers meet the new coach on that row |

If Grok has scheduled tasks, set both up there, so the only manual step is the paste into #558.

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
> 7. **Attack:** pick the three PRs merged in the last 24 h with the highest risk to a real tester (payments, safety, memory, deletion first). For each one, name the exact message a South African tester would send that breaks it, the file and line where it goes wrong, and what the client would see.
> 8. **Money:** no paid tools or new spend. Say if anything in the build is spending money.
> 9. **Blind spots:** anything a strong CTO would worry about that isn't in `RISKS.md` or the open issues.
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
