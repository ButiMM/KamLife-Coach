# Market and delivery room: briefing (CTO, 6 Oct 2026)

This is the starting brief for the separate market/delivery discussion between the founder, the CTO and Codex. Decisions taken there are written into `docs/SYSTEM.md` ("Decisions already made"). The builder follows SYSTEM.md, not the chat.

## 1. What is locked (don't reopen without a reason)

| Decision | Source |
|---|---|
| Surface: WhatsApp with our own backend. No app or member page now | CLAUDE.md orders, 29 Sep |
| The promise, four capabilities: help me now, know my situation, help me follow through (commitment loop), show it's working | #511, #512 |
| Non-clinical scope. Coaching-only (Meta banned general-purpose AI bots on the WhatsApp Business API from 15 Jan 2026). Medical topics go to safety floors | ORDERS, `domain-guard.ts` |
| **Price: R199 to R250 a month.** R149/R99 are not candidates. The first paying group tests R199 against R249. (The code still says R149, so it must change before launch) | SYSTEM.md, 30 Sep |
| 14-day money-back guarantee, no free trial, self-service cancel | #385, #277, #383 |
| No new spend until revenue (no paid gate, services or keys without a written case and a founder yes) | ORDERS §0c |
| Deferred: app/member page, Meta Cloud API direct, new payment rails, second model provider, trainers/buddies | CLAUDE.md orders |
| The founder's 10 manual clients (R250/month, human coaching) stay manual until the bot is accurate. The goal is to move everyone onto the bot | SYSTEM.md, 24 Sep |

## 2. Where the product is (6 Oct)

- **Live for every tester, in the new coach's voice:**
  - what to eat, coaching talk, "how was my week", off-topic redirects, memory;
  - food in words, corrections, steps, workouts, goals and "am I on track";
  - the morning message, the Monday weigh-in, today's workout, and welcome back after silence.
- **Safety in code:** pregnancy, disordered eating, crisis in 5 languages, a friend's crisis, under-18, opt-out.
- **Money:** cancel stops PayFast billing, and the guarantee is wired.
- **Data:** backups test-restored (passing again since 6 Oct), POPIA deletion with tombstones.
- **In PRs:** reminders (#537), the commitment loop (#545), food photo (#550).
- **Not built yet:**
  - voice notes;
  - non-English test cases on every row;
  - onboarding, payments and cancel replies in the new voice;
  - one client record (old memory stores still being retired);
  - live quality signals.
- **Size:** server ~73k lines against a 64.5k checkpoint. Deletions are now forced by expiring rollback flags.
- **Evidence:** `/api/admin/evidence` (#513) gives real usage per client and the final replies. That's the source for real messages per client per day, which drives both cost and price.

## 3. Unit economics we already know (COSTS.md)

- **AI:** ~R0.009 per message on the small model, about R4–R15 per active client a month. `gpt-4o` is used only for crisis and photos.
- **WhatsApp from 1 Oct 2026:** service replies inside the 24-hour window are now billed at about the SA utility rate (~R0.12). Sources disagree on whether 1,000 free a month per number survived. The October Twilio invoice is the truth.
- **Twilio** adds about $0.005 on every message, inbound and outbound.
- **Rule of thumb:** monthly WhatsApp cost per client ≈ 10.2 × C + 6.3 rand, where C = client messages a day. At R199, Twilio + Meta stay comfortable below C ≈ 16. Moving to Meta Cloud API direct saves ~R27–R81 per client a month at C = 5–15 (#493), deferred until ≥20 clients averaging ≥5 messages a day.
- **Product cost levers already pulled:** one paid message per reply (#492), one scheduled message a day (#517), no unasked shopping lists, monthly narrative retired.

## 4. Outside research (6 Oct, web sources; reference only, verify before relying on it)

- **Market:** about half of SA adults are overweight or obese. SA has the highest adult obesity in the WHO African region (30.8% in 2022).
- **Gap:** GLP-1s at R3,000–R6,000+/month (generic semaglutide arrived Aug 2026, only ~18.5% cheaper), dietitians R550–R2,000, WhatsApp coaches R899–R2,699 per programme, budget gyms R199–R299. Nothing affordable, standalone and WhatsApp-native serves the non-medical-aid majority. Discovery/Vitality AI, Momentum + Wysa, Checkers Pixie and Pick n Pay Penny are all gated behind insurance, banking or groceries.
- **Closest local analogues:**
  - Karien Nel: WhatsApp coaching, "answers every message herself — not a bot".
  - Flourish: human WhatsApp coach plus an AI companion, upmarket and medicalised.
  - Weight Doctors: an AI "Coach Iris" in 7 languages, attached to GLP-1s and surgery.
- **Global pattern:** the model is not the moat. The moats are trust, outcome data, distribution and memory. Health apps average ~3% day-30 retention, and annual/multi-month plans cut churn about in half.
- **Their three make-or-break risks:**
  - Meta platform rules and rising message costs;
  - churn;
  - recurring collection in a low-card market. Involuntary churn can be 18–32% of cancellations. Prepaid multi-month bundles, PayShap/Capitec Pay and Ozow are suggested.
- **Suggested angle:** the affordable behavioural companion *alongside* GLP-1s. That means eating on low appetite, protein and muscle, and coming off the jab (STEP 1 extension: two-thirds of the weight regained within a year of stopping).
- **Note:** that report assumed R149 and free service conversations. Both are out of date (see §1 and §3).

## 5. Questions for the room

1. Who exactly is the first paying 50? Same profile as the 10 manual clients, or a different segment (e.g. GLP-1 users, shift workers)?
2. How do we deliver: pure bot, or bot with a visible human (the founder) behind it? What does the founder's time cost per client?
3. Billing: monthly PayFast card/EFT, or prepaid 3-month bundles? (Prepaid needs no new rails.)
4. Which number proves the product works before spending on acquisition? Proposed: day-30 retention and weekly active loggers from the evidence view.
5. Codex's argument from 5 Oct, pasted by the founder, answered point by point.
