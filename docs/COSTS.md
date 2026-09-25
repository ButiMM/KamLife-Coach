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
