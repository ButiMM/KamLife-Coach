# STANDING COST RULES: every builder, reviewer and the CTO follows these (28 Sep)

The founder spent $20 of OpenAI credit in two days (25-26 Sep) after six months on $10. The causes were CI grading with the live model on every push, a history-learning leak re-run on every deploy, and CI sharing production's OpenAI account. These rules stop that from happening again.

**Budgets** (at current tester volume):

| Area | Budget |
|---|---|
| Production AI | ≤ R10 per active client per month |
| CI | ≤ $5 per month, on its own capped OpenAI project |
| Total OpenAI | ≈ $10 per month |

**All-in cost per active client (Codex review, 28 Sep): measure the whole thing, not only tokens.**

| Cost | Scenario (15 client messages and 15 replies a day) |
|---|---|
| Model | ~R4-R14 a month (R0.009-R0.03 a message) |
| **Twilio WhatsApp fee** | **$0.005 per inbound or outbound message ≈ $4.50 a month (~R80), plus Meta template fees outside 24 h.** This is likely **larger than the AI.** |
| Other | Voice (ElevenLabs), PayFast fees, hosting, human escalations, refunds |

Report all-in cost per active client and per retained paying client monthly (#293 digest). Evaluate sending through Meta's WhatsApp Cloud API directly instead of Twilio (#).

**Production (the live bot):**
1. The small model by default. `gpt-4o` only for crisis and photo reading (#474).
2. One-off work runs once per client, ever, with the claim stored in the database, never in memory (#472).
3. No new model call site outside the new coach (the mouth ratchet counts `model_call_sites`).
4. **Founder action:** set Railway `GLOBAL_AI_DAILY_SOFT_CAP_USD=0.50` and `AI_MONTHLY_CEILING_ZAR`. The spend cap fails safe (#367), so a runaway day stops at the cap.

**CI and the gate:**
5. CI uses **its own OpenAI project with a hard monthly cap**, never production's account. Until the founder adds that key, the gate reports NOT TESTED; nobody reuses the production key.
6. The live gate runs **once per switch PR**, when labelled `final` (#473): the strong judge once, the cheap judge otherwise. It never runs on docs, on every push, or on non-switch PRs.
7. Unit, database and acceptance tests never call a live model (stubs only).

**Builders and reviewers:**
8. Claude capacity is scarce: one builder session, short status comments, batched pushes, no local re-runs of what CI runs.
9. Attackers (Codex, the CTO) prove findings offline and never trigger the live gate.
10. Any change that adds recurring cost states its estimated monthly cost in the PR description. No new paid service without a written case and the founder's yes.

---

# What KamLife costs to build and run, and how we keep it low

Maintained by the CTO. MVP rule: **free first.** A paid item needs a written case and the founder's yes (`docs/SYSTEM.md`). Prices are approximate; the founder's billing pages are the truth.

## Running the product (per client)

| Item | Today | Decision |
|---|---|---|
| AI per message (production) | ~R0.009 per message on the small model (gate measurement) | Keep. About R4-R15 per active client a month. |
| **Expensive model (`gpt-4o`, about 16× the small one) still used in production** | Crisis, "complex" messages (keyword-routed: "pain in" on a food story qualifies), grocery refine, onboarding physique and onboarding, photo reading | **Cut:** keep `gpt-4o` only for crisis and photos; everything else on the small model. The new coach stays on the small model unless the gate proves otherwise (#412) |
| Voice notes (ElevenLabs, OpenAI TTS fallback) | Milestone voice notes and weekly recaps; `TTS` on by default; daily caps exist | Keep capped. Confirm the ElevenLabs plan is the cheapest tier that covers the volume |
| WhatsApp (Meta via Twilio) | Replies inside the 24 h window are cheap; templates outside it are charged per message | Proactive sends go through one owner (#319), so they can be budgeted |
| PayFast | A per-transaction fee | Normal cost of payment |

## Building the product (per day)

| Item | Today | Decision |
|---|---|---|
| **Replay gate judge** | Was `gpt-4.1` × 50 judge calls per run | **Cut:** the judge is now `gpt-4.1-mini`, about 5× cheaper. The gate runs only on `ready`/`switch`/`gate` PRs, never on docs, and at most once per PR head |
| Gate ceiling | $2/day was a cap, not the expected spend | **Lowered to $0.50/day** at normal pace. Each run reports its cost on the PR |
| CI (GitHub Actions) | Free: the repo is public | Keep |
| Claude plan (builder, CTO) | The founder's subscription | Keep. One builder session; **no attacker session** (lean verification) |
| ChatGPT/Codex | The founder's subscription; out of capacity this week | Optional attacker when it has capacity. No extra spend |
| Grok | Optional daily whole-product review | Optional, no API spend |
| Railway hosting and database | The founder's plan | Check the plan tier matches traffic |

## Guardrails already in place

- The AI spend cap fails safe (#367).
- Out-of-credits and bad-key errors alert the founder (#398, #401, #402).
- CI can't run the gate on docs.
- The mouth ratchet blocks new AI call sites.
- **Founder action (optional, recommended):** a separate capped OpenAI project for CI (`docs/SYSTEM.md`), so CI can never touch production's credits.
