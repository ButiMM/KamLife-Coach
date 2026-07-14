# Third-party review log

_A running record of outside reviews of KamLife and what we did with each
recommendation — apply / adapt / defer / disagree — so decisions have memory and we
don't re-litigate. Newest review first._

---

## Review #3 — Garry Tan (YC) on positioning + pricing (2026-07-14)

A widely-shared tweet: *"Founders must stop building 2010-era businesses with 2026-era
technology… Don't underprice! If it works it's worth a lot more… The rules of tech
changed with AI. Play the new game."*

- **Validates the direction.** Our "new game" is AI-native: human-coach quality
  (memory, per-client tone/number adaptation, real emotional accountability) at R199 —
  impossible in 2010 (you'd need a human coach at R2000+/mo). Keep positioning as the
  behaviour-change OS, never "a fitness tracker."
- **The one challenge — pricing.** "Don't underprice." Tensions with the mission
  (R199 mass-market). **Resolution (not a raise of the R199 wedge):** build the
  **premium value tiers sooner** (R399/R699, families, corporate wellness, medical-aid)
  so those who can pay for "worth a lot more" do, while R199 stays the accessible
  on-ramp. This moves the premium-tier decision from "much later" to **timely** — still
  a founder call, but flagged as near-term.
- **Clean on "no revenue tricks":** pay-to-start + money-back guarantee is real value,
  not a gimmick.

---

## Review #2 — VC / investment lens (2026-07-14)

Framed as a top-tier VC ("does this become a $100M+ company or die"). Overall 9.1/10;
core message: **you're underselling what you've built — you're not an AI fitness coach,
you're an AI operating system for behaviour change. Sell the transformation, not the
toolkit.** Would take another meeting immediately.

### What we TAKE (and are acting on)

| Insight | Our action | Status |
|---|---|---|
| **Sell transformation, not features.** The doc spends 80% on features; people buy "I've tried everything" and "becoming someone else", not calories. | Reposition: lead every external doc with behaviour change + consistency, features as applications. One sentence: **"KamLife helps ordinary South Africans finally stay consistent with their health."** | ✅ overview repositioned |
| **Codify north-star principles.** | Written into the overview: *Consistency beats perfection · Reduce shame · Every reply reduces cognitive load · Coach before calculator · Human before AI.* | ✅ |
| **A company belief.** ("Why does KamLife deserve to exist?") | Adopted: **"Nobody should fail their health because coaching is too expensive."** | ✅ in overview |
| **Activation > retention. Obsess over the first 5 minutes.** A new member must think "oh wow", not "another chatbot". | **SHIPPED** (server/activation.ts): onboarding ends with a calm expectation-setter (what's required, don't panic, what to expect, at your own pace) + an explicit first-action photo hook; the first log fires a once-only "you just did the whole job" celebration (new accounts only). | ✅ shipped |
| **Measure everything, publish metrics internally** (activation %, W1/W4 retention, CAC, LTV, AI cost/user, gross margin, DAU/WAU/MAU, msgs/day). | **SHIPPED** the money+engagement+quality layer at `GET /api/admin/north-star`: MRR, AI cost/paying member, AI-only gross margin, DAU/WAU/MAU + stickiness, activation %, and 7-day fumble counts. Detailed funnel/retention already lived at `/api/dashboard/funnel`. CAC/LTV omitted (no ad-spend data yet). | ✅ shipped |
| **The data is the moat, not GPT.** Which messages/tone/foods predict churn, by segment — nobody has this SA dataset. | Reinforce behavioural-signal capture (quality_signals is the seed); this is why the tone/numbers adaptation matters. | ongoing |
| **Your competitor is inaction ("I'll start Monday"), not MyFitnessPal.** | Messaging attacks inaction, not other apps. | messaging note |
| **Reframe positioning:** "first AI accountability partner for ordinary South Africans"; fitness is one application (later: BP, diabetes, meds, sleep, savings…). | Adopted as the north-star framing in the overview (without over-promising features we haven't built). | ✅ framing |

### What we DON'T take yet (adapt / defer / founder-decision)

| Insight | Our position |
|---|---|
| **Price tiers R399 / R699 / families / corporate / medical-aid** | Real future upside, but NOT now — focus is nailing the mass-market R199 tier. VC agreed: keep R199 for the target market. Founder decision when we scale. |
| **"You'll need an app eventually"** | Noted, not now. Stay WhatsApp-first; don't build a dashboard/native app/new login (both reviews agree). |
| **"You're charging too little"** | Disagree for now — R199 is deliberately mass-market; the guarantee + pay-to-start already filter for commitment. Premium tiers come later. |
| **Put metrics IN the investor doc** | We don't have meaningful real numbers yet (pre-scale). Build the metrics infra first, publish internally, add to the doc once honest. |
| **Moat question "why can't Meta/OpenAI copy this?"** | Answer is the SA behavioural dataset + deterministic infrastructure + market understanding — not prompts. Captured in the overview's moat section. |

**The VC's single strongest instruction — reposition around transformation/consistency —
is applied to the overview now.** Activation + the metrics view are the next builds.

---

## Review #1 — delivery, literacy & retention (2026-07-14)

Focus: how to be frictionless for every literacy level without overbuilding or eroding
margins. Verdict: architecture sound, pricing right, market insight genuine; risks are
all in execution (retention, literacy adaptation, distribution timing).

| # | Recommendation | Decision | Status |
|---|---|---|---|
| 1 | **Default everyone to number-free; power users opt in** | **APPLIED** — the flagship. `getNumbersMode` now defaults to number-free; `numbers:full` is the opt-in; onboarding tells clients they can say "show me the numbers". | ✅ shipped |
| 2 | **Shame-proof the silent-48h message** ("Life happens. No judgement.") | **APPLIED** — retention 48h message rewritten to lead with absolution + "pick up where you left off". | ✅ shipped |
| 3 | **Emojis as visual anchors (🟢/🟡/🔴)** | **ALREADY DOING** — verdict headline ships 🟢/🟡; extend the traffic-light consistently. | partial |
| 4 | **Commitment streak (counts comebacks, not perfect days)** | **SHIPPED** — a comeback after a gap is reframed as persistence, not a reset (workout.ts). | ✅ shipped |
| 5 | **First-hour commitment hook** (end onboarding with the client sending something) | **SHIPPED** — onboarding ends with an explicit "take one photo of your next meal now" first-action hook + first-log celebration (activation.ts). | ✅ shipped |
| 6 | **Repair-rate metric** (messages-to-resolution after confusion) | **APPLY SOON** — build on the existing `quality_signals` table; better pilot signal than raw retention. | queued |
| 7 | **Replies 2–3 sentences, chunk into multiple messages** | **ALREADY PARTIAL** — we split on `\n\n---\n\n`; keep enforcing brevity. | ongoing discipline |
| 8 | **Voice-note replies as a toggle for low-literacy users** | **ADAPT** — real value, but TTS on *every* reply is NOT marginal cost. Make it an **opt-in toggle**, not default. | queued (opt-in only) |
| 9 | **Shadow-mode brain on every message** (log divergence vs handlers) | **ADAPT** — doubling LLM calls on 100% of traffic erodes the exact margin the deterministic-first design protects. **Sample at ~2–3%**. | queued (sampled) |
| 10 | **Referral: friend gets 14-day trial instead of 50% off** | **FOUNDER DECISION** — protects price perception, but it's a pricing call for Kam, not to ship unilaterally. | flagged to founder |

**Not to build (agreed):** web dashboard / native apps / new login flows (stay
WhatsApp-first); voice synthesis beyond current ElevenLabs use.

**Do invest (agreed):** SA-food photo recognition accuracy (fixed cost, doesn't scale
with users — where trust is won or lost); the adaptive tone system (next moat).

**The reviewer's single highest-leverage call — #1 — is shipped.** #2 shipped. The
rest are queued in priority order above.
