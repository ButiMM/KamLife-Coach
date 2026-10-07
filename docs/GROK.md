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

**Rhythm: two pastes a day, plus Prompt 3 (the whole-product attack) every Monday.**

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

---

## Prompt 3: the whole-product attack (founder's call, 6 Oct). Run it once now, then every Monday. Prompts 1 and 2 stay daily.

> You are the independent auditor of https://github.com/ButiMM/KamLife-Coach, the `main` branch as it is now. KamLife's Coach K is a WhatsApp fat-loss coach for South Africans (R199–R250/month, non-clinical, no app). Production runs on Railway with Postgres, Twilio WhatsApp, OpenAI and PayFast. A new coaching core (`server/core/`) is replacing an old pipeline, row by row (`docs/COVERAGE.md`). You're a different AI family from the builder. **Your job is to find what will stop this from becoming a product people pay for and keep, across the whole system, not one PR.** Don't propose a rewrite. Every finding needs evidence: file and line, issue or PR, or a numbered reproduction. No evidence, no finding.
>
> Read first: `docs/TESTER-EXPERIENCE.md`, `docs/COVERAGE.md`, `docs/ORDERS.md`, `CLAUDE.md` (top blocks), `docs/COMPONENTS.md`, `docs/delete-list.txt`, `docs/RISKS.md`, `docs/COSTS.md`, `docs/SYSTEM.md`, `docs/MARKET-ROOM.md`, and issue #280.
>
> Audit all twelve. For each, give a verdict (**sound / weak / broken**) and the worst finding:
> 1. **Architecture.** Is there truly one path from inbound message to reply? Count the doors where old code can still answer. Name every place two components decide the same thing (two memories, two senders, two target writers). Is `server/core/` actually thin, or is it re-growing the old pipeline?
> 2. **Memory and truth.** Can Coach K state a fact the client never said? Can a correction be lost? Trace one fact from inbound to the client record and back into a reply.
> 3. **Coaching quality.** Using real South African messages (code-switching, voice transcripts, shift work, takeaways, taxi-rank food, braai weekends), show 5 exchanges where the reply would be wrong, generic, repetitive or preachy, and the line that causes each.
> 4. **Safety.** Crisis, pregnancy, eating disorders, minors, medication, opt-out. Is every one enforced in code before any model call, and on every outbound path, scheduled sends included?
> 5. **Proactive messaging.** Every scheduled job: could a client get two messages in a day, a message after cancelling, or a message outside WhatsApp's 24-hour window without an approved template?
> 6. **Money.** Signup → pay → renew → failed charge → cancel → 14-day refund, end to end. Any path that charges wrongly, keeps access after cancelling, or cuts off a payer? Where does the price (R199–R250) live, and does any old R149 survive in code or copy?
> 7. **Cost per client.** Count model calls and WhatsApp messages per typical day for an active client. Name any path that multiplies them. Is the spend cap enforced on every model call?
> 8. **Infrastructure and operations.** Deploys, migrations, backups (restore tested?), health checks, alerting to the founder, secrets handling, rate limits, what happens when OpenAI or Twilio is down. What breaks at 100 clients that works at 10?
> 9. **Security and POPIA.** Webhook authentication, admin routes, data stored about health, retention, deletion that actually deletes (including backups), anything that could leak one client's data to another.
> 10. **Quality system.** Do the tests, gate cases, ratchet and attacks actually catch regressions? Name a class of bug that could ship today with every check green. Which tests are dead weight?
> 11. **Size and deletion.** Server line count against the 64,500 checkpoint, and what's still alive on the delete list. Which 3 deletions would remove the most risk for the least work?
> 12. **Launch readiness.** If 50 paying strangers joined on Monday, what would fail first, in what order?
>
> Finish with:
> - **Top 10 findings, ranked by harm to a paying client.** Each one gets severity (P0 kills trust or money now / P1 hurts this month / P2 later), evidence, the smallest fix, and the `COVERAGE.md` row it belongs to.
> - **The 5 things that would move the project forward most this week**, in order, within the current plan.
> - **What's genuinely good** (one short list), so it isn't broken by mistake.
