# KamLife Coach — South African Compliance Checklist

> **Who this is for:** The founder / business owner. Not a technical document.
>
> **Why this exists:** Running a subscription business in South Africa requires
> legal, tax, and financial registrations that have real deadlines and penalties.
> This checklist tells you exactly what to do, in what order, where to go, and
> roughly what it costs.
>
> **Update this file:** When you complete an item, mark it ✅ and add the date
> and reference number (e.g. company reg number, tax number). This is your paper
> trail if you're ever audited.

---

## Urgency guide

| 🔴 URGENT | Must be done before you take your first payment |
|-----------|-----------------------------------------------|
| 🟡 SOON | Do within 60 days of launch |
| 🟢 WHEN READY | Required at specific revenue thresholds |

---

## 1. Business Registration — CIPC

**Status:** ⬜ Not done

**What it is:** Registering your business as a legal entity with the Companies and
Intellectual Property Commission (CIPC). Without this you're trading as a sole
proprietor under your personal name — which means personal liability for all debts
and legal claims.

**Which structure:**
- **Private Company (Pty) Ltd** — strongly recommended. Limits personal liability.
  Needed for a business bank account, PayFast merchant agreement, and investor discussions.
- **Sole Proprietorship** — no registration needed, but no liability protection and
  looks less credible to clients and partners.

**How to register:**
1. Go to **www.cipc.co.za** → Registers → Companies → New Company
2. Choose "Private Company"
3. Pick a company name (e.g. "KamLife Lifestyle Coach (Pty) Ltd")
4. Pay the registration fee online

**Cost:** R175 (name reservation R50 + registration R125 — as at 2026)

**Timeline:** 5–10 business days online

**What you need:**
- South African ID number
- Proposed company name (have 2–3 alternatives ready in case your first is taken)
- Physical address (your home address is fine)

**Result:** Company Registration Number (CRN) — e.g. 2026/123456/07

**Urgency:** 🔴 URGENT — before taking first payment

**Record here when done:**
- Date registered: ___________
- CRN: ___________
- Company name (exact): ___________

---

## 2. SARS Tax Registration

**Status:** ⬜ Not done

### 2a. Income Tax (IT77C)

**What it is:** Registering the company for corporate income tax. SARS requires all
companies to register for tax within 60 days of incorporation.

**How to register:**
1. Go to **www.sars.gov.za** → Register as a Taxpayer → Companies
2. Or visit a SARS branch with your CRN, company certificate, and company bank letter
3. You can also register via your accountant

**Cost:** Free

**Result:** Income Tax Number — e.g. 2123456789

**Urgency:** 🟡 SOON — within 60 days of company registration

**Record here when done:**
- Date registered: ___________
- Income Tax Number: ___________

### 2b. VAT Registration (VAT101)

**What it is:** Mandatory when your turnover exceeds R1,000,000 per year
(~R83,333/month). Voluntary registration is possible above R50,000/year.

**At R199/month per subscriber:**
- 420 paying subscribers = R83,580/month ≈ mandatory VAT threshold
- 252 paying subscribers = R50,148/month = voluntary registration viable

**Should you register voluntarily?**
Yes, when you reach ~250+ paying subscribers. Voluntary VAT lets you claim back
VAT on business expenses (Railway hosting, etc.). The admin overhead is manageable
with accounting software.

**How to register:**
- Log into eFiling at **www.efiling.sars.gov.za** → Registration → VAT → VAT101
- Or use your accountant

**Cost:** Free to register. You will need to charge VAT (currently 15%) on all
subscriptions, file VAT returns every 2 months, and pay VAT collected to SARS.

**Important:** When you register for VAT, update the pricing and invoices — R199
(VAT-inclusive) or R199 + VAT = R228.85. Decide which before registering.

**Urgency:** 🟢 WHEN READY — at or before 250 paying subscribers

**Record here when done:**
- Date registered: ___________
- VAT Number: ___________
- VAT registration date: ___________
- VAT period: ___________

### 2c. PAYE (Employees Tax) — only if you hire staff

**What it is:** Required if you hire employees (not contractors). Register via
eFiling before the first payroll run.

**Urgency:** 🟢 WHEN READY — only when you hire your first employee

---

## 3. Business Bank Account

**Status:** ⬜ Not done

**What it is:** A separate bank account in the company's name. Required to open
a PayFast merchant account. Also legally cleanest — mixing personal and business
finances creates accounting and tax headaches.

**Best options for a small SA tech business:**

| Bank | Account | Monthly Fee | Notes |
|------|---------|-------------|-------|
| **FNB** | Business Easy Account | R95–R125 | Best online banking; easy PayFast integration |
| **Capitec** | Business Bank Account | R50–R100 | Cheapest; Capitec Pay integration with PayFast |
| **Nedbank** | Business Current | R100–R150 | Good API / integration support |
| **Standard Bank** | Business Flex | R95–R140 | Widespread branch network |

**What you need to open:**
- Company CRN and registration certificate
- CIPC-issued Memorandum of Incorporation (MOI)
- Director's ID (yours)
- Proof of business address
- Initial deposit (varies per bank, usually R500–R1,000)

**Tip:** FNB or Capitec Business are fastest to open and most developer-friendly
for payment integrations.

**Urgency:** 🔴 URGENT — before taking first payment (PayFast requires it)

**Record here when done:**
- Bank: ___________
- Account number: ___________
- Date opened: ___________

---

## 4. PayFast Merchant Account

**Status:** ⬜ Not done

**What it is:** PayFast is the South African payment gateway that processes
R199/month subscription payments from your clients. You need a verified merchant
account to accept card payments, Capitec Pay, and instant EFT.

**How to register:**
1. Go to **www.payfast.io** → Register → Merchants
2. Choose "Business"
3. Fill in your company details (company name, CRN, bank account)
4. Upload required documents (see below)
5. PayFast verifies within 1–3 business days

**Documents required:**
- Company registration certificate (from CIPC)
- Proof of banking (bank statement or letter confirming account in company name)
- Director's ID (copy)
- Proof of address (utility bill, bank statement)
- Website URL and description of what you sell

**PayFast fees (subscriptions/recurring billing):**
- Visa / Mastercard: 2.9% + R1.50 per transaction
- Capitec Pay: 1.5% + R1.00 per transaction
- EFT / Ozow: 1.4% per transaction

**Note:** The KamLife codebase is already coded for PayFast ITN (Instant
Transaction Notification) webhooks, signature validation, and subscription
management. You only need the merchant credentials: `PAYFAST_MERCHANT_ID`,
`PAYFAST_MERCHANT_KEY`, and `PAYFAST_PASSPHRASE`. Set these in Railway.

**Urgency:** 🔴 URGENT — before taking first payment

**Record here when done:**
- PayFast Merchant ID: ___________
- Date approved: ___________
- Railway env set: ⬜ PAYFAST_MERCHANT_ID / ⬜ PAYFAST_MERCHANT_KEY / ⬜ PAYFAST_PASSPHRASE

---

## 5. POPIA (Privacy) Compliance

**Status:** 🟡 PARTIAL (privacy policy published, information officer not registered)

**What it is:** The Protection of Personal Information Act 4 of 2013 requires you
to:
1. Have a published Privacy Policy ✅ (done — `/privacy` page live)
2. Designate an Information Officer and register with the Information Regulator
3. Implement data security measures ✅ (done — data encrypted at rest via Railway, HTTPS, access controls)

### 5a. Information Regulator Registration

**What it is:** Every company that processes personal information must register
their Information Officer with the Information Regulator of South Africa. This is
a free online process.

**How to register:**
1. Go to **www.justice.gov.za/inforeg** → Register Information Officer
2. Log in with your email
3. Fill in: company name, CRN, Information Officer details (name, email, phone)
4. Submit

**Cost:** Free

**Deadline:** Should be done now — technically required under POPIA.

**Information Officer:** The person responsible for POPIA compliance at the company.
For a small business, this is the founder/director (you).

**Also needed:** Update the `INFORMATION_OFFICER` placeholder in
`client/src/pages/privacy.tsx` with your actual name and the `COMPANY_REG` with
your CRN once CIPC registration is complete.

**Urgency:** 🟡 SOON — within 60 days of starting to process customer data

**Record here when done:**
- Information Officer name: ___________
- Registration reference: ___________
- Date registered: ___________

---

## 6. Accounting / Bookkeeping

**Status:** ⬜ Not done

**Why it matters:** SARS will eventually audit you. You need:
1. A clear record of all income (subscription payments)
2. All business expenses (Railway, OpenAI, Twilio, PayFast fees)
3. Proof of VAT in/out (when VAT-registered)
4. Annual financial statements for SARS and any future investors

**Simplest options:**

| Tool | Monthly Cost | Notes |
|------|-------------|-------|
| **Xero** | R250–R400/mo | Best for SA; PayFast integration; VAT-ready |
| **Sage One** | R200–R350/mo | SA-focused; common with SA accountants |
| **QuickBooks Online** | R200–R300/mo | Good mobile app; PayFast integration available |
| **Spreadsheet (manual)** | Free | Acceptable pre-VAT; too risky post-VAT |

**Recommendation:** Xero. It has a direct PayFast integration that auto-imports
your subscription payments and creates invoices automatically. Worth the cost
once you have 20+ paying clients.

**Urgency:** 🟡 SOON — before you exceed 50 paying clients

---

## 7. Domain and Email (Professional Identity)

**Status:** ⬜ Partially done (website live, email addresses may not be set up)

**What you need:**

| Item | Provider | Cost | Notes |
|------|---------|------|-------|
| Domain: kamlifecoach.co.za | ZACR via any registrar | R150–R300/year | .co.za is more credible for SA business |
| Business email: support@kamlifecoach.co.za | Google Workspace or Zoho | R80–R200/month | Don't use Gmail.com for a paying business |
| Email: privacy@kamlifecoach.co.za | Same | — | Required for POPIA contact |
| Email: legal@kamlifecoach.co.za | Same | — | For legal notices |

**Note:** The privacy.tsx and terms.tsx pages reference `privacy@kamlifecoach.co.za`
and `legal@kamlifecoach.co.za`. Make sure these actually work (or redirect to a
real mailbox).

**Urgency:** 🟡 SOON — before launch

---

## 8. WhatsApp Business API (Twilio)

**Status:** ✅ Done (Twilio credentials in Railway)

Verify all environment variables are set in Railway:
- ⬜ `TWILIO_ACCOUNT_SID`
- ⬜ `TWILIO_AUTH_TOKEN`
- ⬜ `TWILIO_WHATSAPP_NUMBER` (your WhatsApp sender number, format: `whatsapp:+27...`)
- ⬜ `TWILIO_SMS_NUMBER` (for critical payment failure SMS alerts)

**Your WhatsApp number must be verified as a WhatsApp Business number through Twilio.**
If you haven't done this, log into **console.twilio.com** → Messaging → Try WhatsApp
and follow the verification steps.

---

## 9. Railway Environment Variables (Launch Readiness)

**Status:** ⬜ Partial

All Railway environment variables must be set before going live. The app will
refuse to start without critical ones:

| Variable | Required | Notes |
|----------|---------|-------|
| `DATABASE_URL` | ✅ Required | PostgreSQL connection string (auto-set by Railway) |
| `TWILIO_ACCOUNT_SID` | ✅ Required | From Twilio console |
| `TWILIO_AUTH_TOKEN` | ✅ Required | From Twilio console |
| `TWILIO_WHATSAPP_NUMBER` | ✅ Required | Format: `whatsapp:+27XXXXXXXXX` |
| `TWILIO_SMS_NUMBER` | ✅ Required | For critical payment SMS alerts |
| `PAYFAST_MERCHANT_ID` | ✅ Required | From PayFast dashboard |
| `PAYFAST_MERCHANT_KEY` | ✅ Required | From PayFast dashboard |
| `PAYFAST_PASSPHRASE` | ✅ Required | From PayFast dashboard |
| `APP_URL` | ✅ Required | Your Railway app URL, e.g. `https://kamlifecoach.co.za` |
| `ADMIN_API_KEY` | ✅ Required | Strong random string for admin dashboard auth |
| `SESSION_SECRET` | ✅ Required | Strong random string for session encryption |
| `OPENAI_API_KEY` | ✅ Required | From OpenAI platform |
| `MEDIA_BASE_URL` | Recommended | CDN base URL for exercise GIFs |
| `USD_ZAR_RATE` | Optional | Default 18.5. Update monthly from trading economics |
| `FINANCE_HOSTING_ZAR_PER_MONTH` | Optional | Default 400 (your actual Railway cost) |
| `SENTRY_DSN` | Recommended | Error monitoring — get from sentry.io (free tier available) |
| `PROACTIVE_PAUSED` | Killswitch | Set to `true` to halt all scheduled messages |
| `NORMALIZER` | Optional | Set to `off` to disable the intent normalizer |

---

## 10. Terms of Service and Legal Pages

**Status:** ✅ Done

| Page | URL | Status |
|------|-----|--------|
| Privacy Policy (POPIA) | /privacy | ✅ Live |
| Terms of Service | /terms | ✅ Live |
| Refund & Cancellation | /cancellation | ✅ Live |

**Human tasks still needed:**
1. Update `INFORMATION_OFFICER` placeholder in `client/src/pages/privacy.tsx`
2. Update `COMPANY_REG` placeholder in `client/src/pages/privacy.tsx` (after CIPC registration)

---

## Summary — Priority order

| Priority | Task | Estimated Time | Estimated Cost |
|---------|------|---------------|----------------|
| 1 | Register company with CIPC (Pty Ltd) | 1–2 hours | R175 |
| 2 | Open business bank account | 1–2 days | R50–R125/month |
| 3 | Register PayFast merchant account | 1–3 days | Free (transaction fees only) |
| 4 | Register with SARS for income tax | 1 hour | Free |
| 5 | Register Information Officer with Info Regulator | 30 min | Free |
| 6 | Set up accounting software (Xero recommended) | 2–3 hours | R250–R400/month |
| 7 | Set up professional email (Google Workspace) | 1 hour | R80–R200/month |
| 8 | Register for VAT | At 250+ paying subscribers | Free to register |

**Estimated first-year compliance cost (cash, excluding ongoing accounting):**
- CIPC registration: R175
- Bank account setup: Free–R500
- PayFast: Free to open
- SARS: Free
- Info Regulator: Free
- Accounting software: R3,000–R4,800/year
- Professional email: R960–R2,400/year

**Total:** ~R4,135–R7,875/year in first year. Well within margin at 30+ paying clients.

---

*This document was prepared for KamLife Lifestyle Coach. It provides general guidance and does not constitute legal or tax advice. For complex matters, consult a South African attorney or tax practitioner.*

*Last updated: June 2026*
