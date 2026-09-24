# Every finding, and where it lives

Nothing from the Grok review, the Claude Code audit (`AUDIT.md`) or the outgoing CTO's handover is dropped. Every finding maps to an issue. Maintained by the CTO. Status as of 24 Sep 09:50 SAST.

## The core problem: many mouths, no memory, no checkpoint

| Finding | Source | Issue | Status |
|---|---|---|---|
| 54 exits in `routeMessage` before the Meaning Engine: first handler to match speaks | Grok §0-1, audit Part A | #272 | lane B; mouth ratchet blocks any increase (#289) |
| 132 outbound send sites in 35 files; cron jobs send without the decision owner | Grok §3, audit | #319 | lane B |
| Coach prompt is 68k characters, sliced to 20k: ~46k never reaches the model | Grok fact 2 | #320 | lane B |
| Client facts never stored: six regex-filled fields; "knee gets sore" discarded | audit Part A (Comrades/knee) | #271 | lane B |
| Three different recency windows (4/5/6 turns) across three code paths | audit | #272 | lane B |
| `turn_ledger` purged after 90 days; no durable event record | audit, handover | #271 | lane B (retention designed first) |
| Embeddings behind an off flag | Grok §4 | #271 | lane B (decide in design) |
| 194 writers to the `users` row; ~40 to `profile_notes` | audit Q1/Q4 | #271 | lane B |
| Conversation state in an in-memory map, lost on every redeploy | audit | #322 | lane B |
| Normaliser rewrites client text: drops days and emotion, invents meal slots | audit Part B, #119, handover | #323 | lane B |
| 93% of messages trigger a classifier model call (8 fast paths) | audit C5 | #272 | lane B (the understanding step replaces it) |
| No merge gate on the real customer path; tests ran with the model off; 10 real messages | Grok §5, audit Q5 | #270 | lane B, PR #298 |
| Coach Health shows what the system believes, not what clients got | handover, founder | #293 | lane B |
| Voice journey proven with typed text | handover §5 | #330 | lane B |
| Builders pushed straight to production; 59% of changes unchecked | CTO | #261 | **done** |
| 48 docs contradicting each other and the code | CTO | #331 | lane B |

## Harm to clients, money and data

| Finding | Issue | Status |
|---|---|---|
| Cancellation didn't stop PayFast; a charge silently reactivated | #263 | **done** (#277, live) |
| Pregnancy got a weight-loss target; purging got a food question | #266 | **done** (#283, live) |
| A meal decline deleted the logged meal | #264 | PR #282, tests running |
| Opt-out only worked for the exact word STOP | #265 | PR #285, tests running |
| Opt-out inside a life-context message ignored | #286 | lane A |
| Under-18s could sign up | #267 | PR #305, tests running |
| Five inconsistent calorie floors; a sex-blind 1,200 | #268 | PR #304, tests running |
| "Delete my data" kept 11 tables | #269 | PR #307, tests running |
| Scope enforced by prompt only; domain guard fails open (Meta risk) | #321 | lane A |
| Multi-day logs collapse into one mislabeled row | #324 | lane A |
| Post-midnight meals land on the wrong day; offset hand-rolled in 98 places | #325 | lane A |
| Same meal, different calories; corrections no-op | #326 | lane A |
| Evening coaching outside 24h arrives as a generic check-in | #327 | lane A |
| 14-day money-back promised, not implemented | #328 | lane A |
| Nutrition direction from code (cut carbs) with no professional | #329 | lane A |
| Correction edge cases found by Codex | #292, #300 | lane A |

## What testers see every day

| Finding | Issue | Status |
|---|---|---|
| "Log a meal" nag while mid-conversation; invented 14-week absences; daily weigh-in nag; "pap and wors" misread | #275 | PR #290, tests running |

## Parked by founder decision

| Item | Note |
|---|---|
| Coach K price | Founder wants R199–R249; code says R149. Decide when the coach works. |
| C18 (#260) | Frozen; its tests carried into the gate by #273. |
