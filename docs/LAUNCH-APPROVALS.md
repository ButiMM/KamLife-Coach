# Every approval, start to finish — the next five days

**Written 29 July 2026.** For Kam. Not a technical document.

This replaces the earlier scattered lists. It covers **only things that need someone
else's approval** — Meta, PayFast, a bank, a regulator. Anything you can do yourself
without waiting is not in here, because waiting is the only thing that costs you days.

Read the "Already done" section first. Several things you have been told are blockers
are not.

---

## Already done — stop paying attention to these

| Thing | Evidence | Who told you otherwise |
|---|---|---|
| **WhatsApp Business sender, live** | Your chat header reads "Kamlife Coach — Business Account". Six named clients in your list. The bot replied at 09:29 and `Engagement` returned at 11:29 today. | An advisor said you have "no live message pipe" and quoted 5–10 days for business verification and display-name approval. Both are **behind you** — that is what a live Business Account means. |
| **Payments, live** | `selfcheck` returns Payments LIVE. `PAYFAST_MERCHANT_ID` and `APP_URL` are set in Railway. | The same advisor asked whether you had "Stripe/Paystack/Yoco". You are on **PayFast**, and the ITN webhooks, signature validation and subscription handling are already written. |
| **Legal pages** | `/privacy`, `/terms`, `/cancellation` are live. | — |

**What this means:** the long pole everyone has been quoting you — Meta business
verification — is not in your path. You are past it.

---

## DAY 1 — today. The only thing actually blocking the product.

### 1.1 Submit four WhatsApp message templates ⏱ ~30 min of your time

**Why this is urgent:** WhatsApp only lets you send freeform text within **24 hours of
the client's last message**. Outside that window every send is rejected unless it is an
*approved template*. You have 24 proactive job files and zero approved templates. So
right now:

- Bonolo has been quiet 5 days. **The coach physically cannot message her.**
- Any client who didn't message yesterday gets no morning message.
- A failed-payment alert reaches nobody.

It fails silently. Nothing errors. The client just stops hearing from you.

**Do this:**

```
npx tsx script/template-pack.ts
```

It prints all four exactly as they must be entered. Then:

1. Twilio Console → **Messaging** → **Content Template Builder** → Create new
2. For each of the four: paste the name, pick the category shown, language `en`,
   content type Text, paste the body between the lines, fill the sample values.
3. Submit.

**Timing:** Meta's stated SLA is **up to 24 hours**. In practice most templates come
back in **minutes**. Submit all four together — they review in parallel, so four
templates is not four times the wait.

**Why they should pass first time:** the texts are pre-checked against Meta's
mechanical rejection rules (placeholder at the start or end of the body, gaps in the
numbering, adjacent variables, missing sample values, promotional wording in a UTILITY
template). Those are what a rejection is usually for, and each one costs a day.

4. When each is approved, copy its `HX…` SID into Railway:

| Template | Railway variable |
|---|---|
| `kamlife_daily_plan` | `TWILIO_DAILY_TEMPLATE_SID` |
| `kamlife_weekly_check` | `TWILIO_WEEKLY_TEMPLATE_SID` |
| `kamlife_payment_failed` | `TWILIO_PAYMENT_TEMPLATE_SID` |
| `kamlife_checking_in` | `TWILIO_REENGAGE_TEMPLATE_SID` |

5. Send `selfcheck` on WhatsApp. The line "Reaching quiet clients (24h+)" should be gone.

### 1.2 Set `TWILIO_SMS_NUMBER` in Railway ⏱ 2 min, no approval needed

The last remaining critical from `selfcheck`. It is the backstop when a payment alert
can't reach someone on WhatsApp. Buy an SMS-capable number in Twilio, paste it in.

---

## DAY 1–2 — payments. Read this before you touch anything.

### The question you asked: does WhatsApp have a payment method?

**Not in South Africa.** WhatsApp Pay — the native in-app payment feature — runs in
India, Brazil and Singapore. It has never launched here. What *does* exist in SA are
bank and gateway products that operate *inside* a WhatsApp chat (Absa ChatWallet;
Payfast has a WhatsApp municipal-billing integration; Nedbank's Money Message, now
discontinued). None of them is a drop-in "collect R199/month" button, and adopting one
would mean rebuilding a payment layer you already have working.

**Do not chase this.** It is a distraction with a rebuild attached.

### The question behind it: what do South Africans actually pay with?

For your market specifically — mass market, no credit card assumed:

| Method | Why it matters to you | Already available on PayFast? |
|---|---|---|
| **Capitec Pay** | The one that matters most. Pays **straight from a Capitec bank account via smartphone — no credit card, no debit card**. Capitec is the bank your market actually uses. Around **40% of payment value** on one major SA gateway's platform. No setup or monthly fees. | Yes |
| **Instant EFT** | Bank-to-bank, customer authenticates in their own banking app, funds confirmed in real time. **Cheaper than card and cannot be charged back.** | Yes |
| **Card** | Still ~54% of online consumers' stated preference — but that is *online shoppers*, a wealthier slice than your market. | Yes |
| SnapScan / Zapper / Mobicred | Marginal for a subscription. | Yes |

**The answer: turn on Capitec Pay and Instant EFT in your PayFast dashboard.** You
already have the gateway. This is a settings change, not an integration. Requiring a
credit card at signup is a conversion killer in your market, and it is optional.

### ⚠️ The thing you must verify before Day 2 — I could not confirm it

PayFast's **recurring billing works by card tokenization.** Everything I can find says
tokenization is **credit and cheque cards only**. I could not reach PayFast's own
subscriptions page to confirm whether **Capitec Pay or Instant EFT can carry a
recurring subscription**, and this is too important to guess at.

**If recurring is card-only, this is a real commercial problem for you:** your clients
may be exactly the people without a credit card.

**Call or email PayFast support and ask this one question:**

> "Can a Capitec Pay or Instant EFT payer be set up on a recurring monthly
> subscription, or is recurring billing card-only?"

**If the answer is card-only, you are not stuck** — and the fix is something you are
already building today. Take the first payment by Capitec Pay or Instant EFT (no card
barrier at signup), then send a payment link every month over WhatsApp. That is a
UTILITY template, it is cheap, it cannot be muted, and the machinery is the
`kamlife_payment_failed` template you are submitting this morning. **Your monthly
payment request becomes the billing system.** For a cardless market that is not a
workaround, it is the correct design.

Write the answer here when you have it: `_______________________`

---

## DAY 2–3 — company and compliance

I cannot see any of this from the code, so **confirm each one yourself** rather than
trusting the old checklist in `docs/SA_COMPLIANCE_CHECKLIST.md` — it says PayFast is
"not done" while your `selfcheck` says payments are live, so it is out of date
somewhere.

| # | Thing | Who approves | Realistic time | Cost | Blocking what? |
|---|---|---|---|---|---|
| 1 | **CIPC company registration (Pty) Ltd** | CIPC | 5–10 business days | R175 | A *business* PayFast account and a business bank account. **Not** blocking you taking money today if you are already receiving it. |
| 2 | **Business bank account** | Your bank | 1–2 days once CIPC is done | R50–R125/mo | PayFast business verification |
| 3 | **PayFast merchant — confirm which tier you are on** | PayFast | 1–3 days if upgrading | Free | Nothing today. But check whether you are on a personal/sole-prop account, because there are payout and volume limits you do not want to discover at 40 clients. |
| 4 | **SARS income tax registration** | SARS | ~1 hour, free | Free | Nothing now. Legally due within 60 days of incorporation. |
| 5 | **Information Officer with the Information Regulator** | Info Regulator | 30 min, free, online | Free | Nothing operationally. POPIA requires it and you are processing health data. Do it — it is free and it is 30 minutes. |

**The honest ranking:** none of #1–#5 stops you selling this week. #1 and #2 stop you
*scaling* and they take the longest, so start #1 today in the background even though it
blocks nothing today. #5 costs you half an hour and closes a real legal exposure.

---

## DAY 3–5 — buffer

Deliberately empty. It is there because Meta may reject a template and you will want
the days back. If nothing gets rejected, this is time to sell.

---

## The five-day checklist, on one screen

**Today**
- [ ] Run `npx tsx script/template-pack.ts`
- [ ] Submit all 4 templates in Twilio Content Template Builder
- [ ] Set `TWILIO_SMS_NUMBER` in Railway
- [ ] Ask PayFast the recurring-billing question above
- [ ] Start CIPC registration (blocks nothing today, takes the longest)

**As approvals land**
- [ ] Paste 4 `HX…` SIDs into Railway
- [ ] Send `selfcheck` — confirm "Reaching quiet clients" is gone
- [ ] Enable Capitec Pay + Instant EFT in PayFast

**This week**
- [ ] Register Information Officer (30 min, free)
- [ ] Confirm PayFast account tier
- [ ] SARS registration once CIPC is through

---

## What I could not verify, and you must

Being explicit about this because you have been given confident wrong answers all day,
including by me.

1. **Whether Capitec Pay / Instant EFT support recurring billing.** Ask PayFast. This is
   the single most commercially important unknown on this page.
2. **Your CIPC / bank / PayFast account status.** The repo's compliance checklist
   contradicts your own `selfcheck`. Only you can see the actual accounts.
3. **Exact Meta template review time for your account.** The SLA is 24 hours; most come
   back in minutes; a rejection resets the clock. I am not going to promise you a number
   I cannot control.
4. **Your per-conversation WhatsApp cost.** Once templates are live you are billed per
   conversation, not per message. At R199/month with daily proactive messages this
   matters to your margin. Check Twilio's current South Africa rates before you scale
   past ~50 clients. It does not matter at 3.
