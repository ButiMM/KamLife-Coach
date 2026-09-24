# Nightly CTO sweep: the checklist that runs without anyone asking

**No paid service runs this.** The watch checks the countable items for free every 10 minutes: stuck PRs, blockers, the delete list, mouths, size, AI call sites, production, findings older than two days with no PR, and layers merged without a `Retires:` section. The judgment items (5 and 14 especially) are answered **once a day by Codex** (already paid for through ChatGPT), and by the CTO whenever the founder is in chat. The reviewer reads this repo cold and answers every question below **with evidence** (file and line, issue, or number). It then posts one report issue labelled `cto-sweep`, and opens a new issue (labelled `harm` or `core`, plus `owner:claude-code`) for every gap nobody is tracking. It never changes code. It never asks the founder anything already in `docs/SYSTEM.md`.

## 0. Width (against `docs/COVERAGE.md`; `docs/ORDERS.md` §0). Answer this first
0a. Which coverage rows moved toward complete since the last sweep? Which reached complete?
0b. Which rows still have **zero** gate cases, or no live metric? Name the three with the most tester impact.
0c. Which foundations are started but not wired or not finished (a module, store or pipeline written and not used)? Did anything merged start a new one beside them?
0d. Is the work spread across the product, or has it narrowed to a few rows? If a week passed with no row reaching complete, say so plainly: that triggers the stop-and-reassess rule.

## Product (against `docs/TESTER-EXPERIENCE.md`)
1. For each of the 8 journeys: which message families have switched to the new core, what does the gate score say, and what is the next journey to switch?
2. Does anything in the never-see list still happen? Check Coach Health and the gate's failures.
3. Are testers' 👎 flags (#360) turning into gate cases? How many are open?

## Architecture (against `docs/COMPONENTS.md` and `docs/ORDERS.md`)
4. Did anything merged in the last 24 h **add** a store, handler, speaking path or AI call without retiring one? Name the PR.
5. Is the new core **calling** the reuse tools, or re-implementing them? Does any number in a reply come from the model instead of code?
6. `docs/delete-list.txt`: how many files still exist? Did the count fall since yesterday? Mouth counts, code size, model call sites: which way did they move?

## Delivery
7. Which PRs are stuck, and on what: an attack, failing checks, a conflict, the founder? Is any `BLOCKED:` older than 2 hours?
8. Is the queue order still right given what merged? Are the lanes actually running in parallel?
9. Is anything in `docs/FINDINGS.md` or `docs/RISKS.md` still open with no PR, and more than two days old?

## Infrastructure and security
10. Did backups run in the last 24 h? Did any scheduled workflow fail?
11. Are there open Dependabot or secret-scanning alerts?
12. Does production `/health` run the same commit as `main`?

## Cost
13. Model calls per message and cost per active client per day: within the R0.10-per-message ceiling?

## Anything else
14. What would a strong CTO worry about here that none of the questions above covers? Say it, and open an issue if it's real.
