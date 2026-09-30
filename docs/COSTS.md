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

Report all-in cost per active client and per retained paying client monthly (#293 digest). Evaluate sending through Meta's WhatsApp Cloud API directly instead of Twilio (#484).

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

## WhatsApp transport: Twilio or Meta Cloud API direct (#484, builder, 29 Sep)

**Prices** (approximate; the billing pages are the truth):
- **Meta (both paths pay this):** from 1 Oct 2026 a service reply inside the 24-hour window is billed at the SA utility rate, about R0.12, after 1,000 free a month per number (#488). Templates outside the window are billed as before.
- **Twilio (only on Twilio):** about $0.005 (≈R0.09) on every message, **inbound and outbound**.
- **Cloud API direct:** no per-message fee on top of Meta's.

**Per active client per month.** C is client messages a day. Since #492, a reply is about one outbound message.

| C (messages/day) | Twilio fee (in + out) | Meta fee (out, after the free 1,000) | Saved by going direct |
|---|---|---|---|
| 5 | ≈ R27 | ≈ R18 | ≈ R27 |
| 10 | ≈ R54 | ≈ R36 | ≈ R54 |
| 15 | ≈ R81 | ≈ R54 | ≈ R81 |

Against R199-R249 a month, Twilio's fee is the largest cost after Meta's once C ≥ 10. It's more than the AI (≤ R10 a client, above).

**Measure C first** (production, founder or CTO):
```sql
SELECT round(avg(n), 1) AS messages_per_client_day FROM (
  SELECT user_id, date_trunc('day', created_at) d, count(*) n FROM chat_history
  WHERE created_at > now() - interval '14 days' AND message_in NOT LIKE '[system]%' GROUP BY 1, 2) t;
```

**Migration surface (measured in code, 29 Sep).** Delivery already has one owner, which makes this tractable:

| Part | Where | Work |
|---|---|---|
| Outbound send | `server/outbound-delivery.ts` `deliverTwilioMessage` (both doors) | Swap the client call for a Graph API `POST /messages`; keep the retry and verdict |
| Inbound webhook + signature | `server/routes/whatsapp.ts` (Twilio form fields, `validateRequest`) | New JSON payload parser; `X-Hub-Signature-256` check; webhook verify handshake |
| Media in (photos, voice notes) | `routes/whatsapp.ts` (`MediaUrl0`) | Media ID → Graph fetch with the app token |
| Templates | 14 `contentSid` references, `server/whatsapp-templates.ts` | Map Twilio Content SIDs to Meta template names; re-approve under our own WABA |
| Interactive, status callbacks | `server/twilio-interactive.ts`, `routes/payments.ts` `/webhook/status` | Port to Cloud API message types and status webhooks |
| SMS fallback | `sendCriticalAlert` | Stays on Twilio SMS (founder alerts only) or moves to another SMS provider |

Effort: about 4-5 small PRs behind a `WHATSAPP_TRANSPORT=twilio|meta` flag (instant rollback), plus founder work.

**Risks and founder work:**
- Meta Business verification and our own WABA.
- Moving the number off Twilio (a short cut-over window).
- Template re-approval.
- Losing Twilio's queue and console. Our own retry and delivery receipts (Cut 6) already cover most of it.

**Recommendation:**
- **Go direct once C is measured at 5 or more a day with 20 or more active clients**, after wave 1 has settled. At C = 10 and 20 clients, that is about **R1,000 a month saved**.
- Below that, Twilio's fee is small in absolute terms and the migration effort isn't worth it yet.
- No migration without the founder's yes.
