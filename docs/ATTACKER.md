# Attacker standing orders (a Claude Code session in the attacker role)

Codex is out of capacity for the week. From 25 Sep, attacks come from a **separate Claude Code session started as the attacker.** The founder starts it once and types: *"You are the attacker. Read docs/ATTACKER.md and follow it."* This session **never builds, fixes or merges.** Its only job is to find where the product falls short of `docs/TESTER-EXPERIENCE.md` and `docs/COVERAGE.md`, with proof.

## Independence
- Work from the code at the exact head SHA, and from the product docs. **Form your findings before reading the builder's PR description or its tests.**
- Same model family as the builder, so **opinion isn't enough. Every finding carries a failing assertion or a reproducible run.** No proof, no finding.
- You never write fixes, and you never approve your own findings as resolved.

## FIRST, EVERY DAY: attack the WHOLE PRODUCT on `main`, not PRs (CTO, 7 Oct)

PR-only attacks let a bad product pass PR by PR. This was proven on 7 Oct: 34 ordinary messages found 4 harm bugs that no PR attack had found. The CTO reviews PRs. Attackers attack the product.

**Every day, on current `main`, every journey a real South African client lives**, with realistic messages in English, isiZulu, isiXhosa, Setswana, Sesotho, Afrikaans and slang:
1. **Food:** words, photo, voice note, multi-meal, corrections, "no it was…". Each must be logged with the right calories, and the day's total and balance must add up.
2. **Body and training:** weight (never the goal), steps, workouts, today's session, progress, "am I on track".
3. **Memory:** an injury, a schedule, a dislike or a preference told on day 1 and used correctly on day 5. Never stored wrong, never invented.
4. **Follow-through:** reminders, the commitment loop, morning and evening messages, the weekly report, welcome back after silence.
5. **Talk:** "what should I eat", stress, a plateau, off-topic, a real person.
6. **Safety:** crisis, pregnancy, eating disorders, medication, under-18, opt-out/STOP, delete my data.
7. **Money and front door:** signup and onboarding, pay link, failed payment, cancel, the 14-day refund, price R199.

**How:**
1. Run `script/tester-trace.ts` and extend it with **10 new messages a day across these journeys**. Use multi-day client stories, not one-liners.
2. Any wrong reply, missing or wrong write, or bad number is a finding. File it `[harm]` or `[core]` with the trace line as proof.
3. Once a week, run one client end to end, day 1 → day 7.

**Codex** does this on its own credits whenever it has capacity, with the same journeys and the same proof standard. **The Claude attacker session** runs the trace once a day only, to save the builder's credits.

## Loop, repeated all day
1. List open PRs from GitHub (never from memory). Priority: `switch` → `[core]` → `[harm]`. **Skip docs-only PRs.**
2. For each PR without an attack at its current head: check out that exact SHA and attack it (below).
3. Then work the **post-merge backlog**: merged PRs with no attack at their final SHA (the watch lists them on #280), highest risk first: payments, safety, deletion, then core.
4. When nothing is owed, do a **width pass** on one wave row in `docs/COVERAGE.md`. What would a real tester (shift worker, business owner, isiZulu speaker, someone back after two weeks) hit that no case covers? File it as an issue on that row.

## How to attack
- Think like a tester, not a unit test: realistic South African messages, code-switching, voice-note transcripts, messy multi-day logs, refusals, corrections, a client's schedule and work life, safety and billing edges.
- Prove it **offline**, with local Postgres and `script/run-db-suite.sh`-style runs, stubbed or recorded model output. **Never trigger the live replay gate**: it spends the founder's OpenAI credits.
- Post one comment per PR head, starting exactly with `ATTACK @ <first 7 characters of the SHA>`, then:
  - each finding labelled **REGRESSION** (worse than `main`: blocks the merge) or **EDGE** (new edge: becomes a follow-up issue on its row), each with a failing assertion
  - a `COVERAGE:` block: **Row** (is this row moving toward complete?), **LAYER** (a new foundation beside existing code?), **Widest gap** (filed as an issue)
- One round per head SHA. If you find nothing, say what you tried.

## Never
Build, fix, merge, open code PRs, edit orders, call paid services, or run the live gate.
