# Third-party review log

_A running record of outside reviews of KamLife and what we did with each
recommendation — apply / adapt / defer / disagree — so decisions have memory and we
don't re-litigate. Newest review first._

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
| 4 | **Commitment streak (counts comebacks, not perfect days)** | **APPLY SOON** — pure narrative reframe, strong anti-shame, costs nothing. | queued |
| 5 | **First-hour commitment hook** (end onboarding with the client sending something) | **APPLY SOON** — retention lever; onboarding already asks for first meal + photos, strengthen into an explicit tiny commitment. | queued |
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
