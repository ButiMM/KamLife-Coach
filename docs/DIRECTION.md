# DIRECTION: where Coach K is going, and how we finish (CTO, Wed 7 Oct 2026)

This is the single direction document. The builder, the attackers and the CTO work from it. It changes only on Mondays, or for something harming clients. It replaces every "new plan" before it. **It adds nothing new. It finishes or deletes what we already have.**

## 1. Where we're going (unchanged since 29 Sep)

Coach K is a WhatsApp coach that does four things for a South African trying to lose fat: **helps them now, knows their situation, helps them follow through, and shows it's working.**

**The finish line:** 50 paying strangers at R199 a month, with these true for 7 days running:
- every meal, weight, step count and workout they report is logged correctly;
- nothing they told us is forgotten or recorded wrong;
- no reply in the daily worst-five report is wrong or embarrassing;
- safety, billing and opt-out stay correct.

## 2. How (one shape, no alternatives)

1. **Floors in code, first:** safety, opt-out, POPIA, onboarding, payment and cancel, and pending yes/no answers.
2. **Then one coach for everything else.** It reads the message, uses the tools that already work (food writer, steps, weight, workouts, reminders, targets, client record), then replies.
3. **The old handlers stop answering.** They become tools, or get deleted.

## 3. The culture rule: finish or delete

We build things to about 80% and move on. That's why the product is bloated and nothing catches anything. From today:
- **No new tool, instrument, review process or measurement** until everything in the table below is either FINISHED (wired into the daily loop and used) or DELETED.
- **Done = proven in production:** 3 days of real tester replies, plus the founder's phone test. Merged isn't done.
- **A conversation with the founder doesn't change the builder's order.** Only this document does, on Mondays.

## 4. Everything we've built: finish or delete

| Built | Decision | How it's finished or removed | By |
|---|---|---|---|
| New coach (`server/core/`) | **FINISH** | In front of everything (#592) | Thu 8 Oct |
| Executor (the coach's hands) | **FINISH** | Logs for every client (#593); workout tool added | Thu 8 Oct |
| ~54 old handlers in front | **DELETE** | Unreachable after #592, deleted 7 days later (#568) | Thu 15 Oct |
| Meaning engine (old second coach) | **DELETE** | With #568 | Thu 15 Oct |
| Shadow mode (would-be actions) | **DELETE** | Superseded by the coach acting for real | Thu 15 Oct |
| Delete-list files (13 left) | **DELETE** | With #568 and D2 | Wed 21 Oct |
| Client record (one memory) | **FINISH** | The 8 old stores collapse into it (D2) | Wed 21 Oct |
| Coach Health hourly sweep | **FINISH** | Feeds the daily worst-five report (D7, merged). Nothing else reads it | Done |
| "audit" command (bad-reply scan) | **FINISH** | Its counts go in the daily report | Fri 9 Oct |
| Evidence page | **FINISH** | Weekly numbers to the founder every Monday: messages per client, cost per client, retention | Mon 12 Oct |
| Tester trace (`script/tester-trace.ts`) | **FINISH** | Run daily by the attacker on `main`, +5 messages a day | Daily from now |
| Journey lab | **DELETE** | Merged into the tester trace | Fri 16 Oct |
| Replay gate (paid) | **KEEP OFF** | Runs only when the founder approves the spend. No other paid testing | — |
| Commitment loop | **FINISH** | Grok's fixes (#564), then proven | Fri 9 Oct |
| Reminders, morning/evening, weigh-in, welcome back | **FINISH** | Proven in the daily report | Wed 14 Oct |
| Voice notes (A4) | **FINISH** | Transcribed into the same coach | Wed 14 Oct |
| Signup, payments, cancel in the coach's voice (C1–C3) | **FINISH** | Floors stay in code | Wed 21 Oct |
| Test harnesses for deleted code | **DELETE** | With each deletion | Ongoing |

## 5. Milestones (estimates; each one ends with proof, not a merge)

- **M1, Thu 8 Oct: the coach is in front, and logging works for everyone.** Proof: the tester trace and 3 days of the daily report.
- **M2, Thu 15 Oct: old handlers deleted.** Weight-goal, fish and receipt bugs gone, voice notes in. Proof: 3 clean days.
- **M3, Wed 21 Oct: one memory, signup and payments in the coach's voice, server under 64,500 lines.** Proof: 3 clean days.
- **M4, from Mon 26 Oct: the finish line in §1.** First paying strangers, invited in groups of 10.

## 6. Who does what

- **Builder (Claude Code):** builds this document's table, top to bottom. One PR per row.
- **Attackers (Claude attacker session, Codex, Grok):** the daily tester trace first, then switch and harm PRs, then Grok's whole-product attack on Mondays.
- **CTO (Claude, chat):** keeps this document, reviews when Codex is out, reads the daily report, and tells the founder in plain words every morning.
- **Founder:** decisions only he can make (price, money, legal, people), and his phone test at each milestone.
