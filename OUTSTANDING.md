# OUTSTANDING — the only list

**Target: first paying clients on 1 September 2026.**
Last updated: 2026-08-03 (late).

> This file replaces `HUMAN_TASKS.md`, `BACKLOG.md` and `docs/NEXT-SESSION.md`, all of which
> were stale and one of which was wrong (it gave the PayFast notify URL as `/payfast/itn`;
> the real route is `/webhook/payfast`). One list, or the lists start contradicting each other.
> `LAUNCH_BLOCKERS.md` stays, but as an evidence record of fixed security findings — not a to-do.
>
> **Claude's standing instruction from the founder (2026-08-03):** recite the open items at the
> end of every session, no matter what the session was about. Especially when he says he is
> launching or has been approved — that is when the forgotten items bite.

---

## HIS — Koketso only

Full click-by-click instructions: `docs/KamLife Coach - Founder Setup Manual.docx`.

### Week 1 — 3–7 August  (the gate is Meta, and Meta needs CIPC)
- [ ] CIPC company registration on bizportal.gov.za — **name it KamLife Coach (Pty) Ltd**
- [ ] Domain kamlifecoach.co.za
- [ ] New prepaid SIM for the bot — **never 065 882 9664**, never install WhatsApp on it
- [ ] Business bank account + stamped confirmation letter
- [ ] privacy@ and kam@ on the domain, both tested
- [ ] Meta Business Portfolio, details matching CIPC character for character
- [ ] Meta Business Verification submitted — **three attempts total, run the checklist first**
- [ ] PayFast merchant account
- [ ] Information Officer registration (POPIA) — inforegulator.bizportal.gov.za
- [ ] OpenAI + Twilio data agreements
- [ ] Send Claude: registration number, full legal name, domain, new phone number

### Week 2 — 10–14 August
- [ ] Twilio WhatsApp sender registered, display name approved
- [ ] Four templates submitted and approved → SIDs into Railway
- [ ] Webhook → `/twilio/whatsapp`, status callback → `/webhook/status`
- [ ] All Railway variables set (Appendix B of the manual)
- [ ] R1 live PayFast payment, all four checks pass
- [ ] `PROACTIVE_PAUSED` deleted — last, after everything above
- [ ] **Trademark TM1 on KAMLIFE, class 41** — see below
- [ ] **Rotate the ElevenLabs API key** — it was exposed in the codebase once and is still live

### Week 3 — 17–21 August
- [ ] 20 clients onboarded onto the real number
- [ ] Day-one photo and weight recorded for every one of them — this is the before/after,
      and 8 weeks from mid-August is mid-October. The clock only starts once.

### Week 4 — 24–31 August
- [ ] Collect every wrong reply as a screenshot, bring the batch
- [ ] Real invoices — Twilio, OpenAI, Railway, ElevenLabs — so cost-per-client stops being an estimate

### Anytime
- [ ] Exercise GIFs uploaded → tell Claude to flip the slug list on
- [ ] Portion-guide images uploaded (already designed)
- [ ] Landing page hero video

---

## TRADEMARK — new, 2026-08-03

Registering at CIPC gives you the **company name**. It does not stop anyone using "KamLife"
as a brand. Those are two different registers.

1. Search free first: CIPC trade marks database, and a plain Google. If someone is already
   using it, better to know in August than in December.
2. File **Form TM1**, one application per class. South Africa is single-class — no
   multi-class applications.
3. **Class 41** is the one: coaching, training, fitness instruction. That is your business.
   Class 44 (health/nutrition advice) and class 9/42 (software) are the second and third
   applications if you ever want them. Start with 41.
4. Official filing fee is about **R590 per class**. Confirm on CIPC's current fee schedule
   before paying — fees move.
5. Registration takes 6–9 months if nobody opposes. **But protection runs from your filing
   date, not your approval date.** That is why filing in August matters and waiting does not.
6. You can file it yourself on CIPC e-filing. An attorney costs R3,000–R8,000 and is worth it
   only if the search turns up something close.

---

## MINE — code

Every item names where it came from. Nothing is on this list because it would be nice.

### FIRST ITEM NEXT SESSION — the stored-target backfill (founder directive, 2026-08-05)

The formula was corrected on `54482ef` and verified: a client onboarding today gets the right
number. `calorieTarget` is a COLUMN, so the rows written before that commit still hold the old
figure — the founder's own reads 2849 where the code computes 3057. Three rows: him and the two
live clients. It does not block the beta (every beta user signs up fresh onto correct math) and
it must not wait longer than one session.

**Scope:** all existing user rows. Recompute from BMR + the derived activity multiplier + the
goal adjustment; write `calorieTarget`, `proteinTarget`, `stepsTarget`.

**Tell them, do not just change it.** One note per corrected client: *"Your daily targets have
been recalibrated for your training schedule — [new target]. Enough to lose fat without losing
muscle."* A client's calories changing silently is the thing the auto-adjust was disabled for;
a backfill that does it quietly would be the same sin with a different name.

**Do NOT unlock the auto-adjust** (`TREND_AUTOADJUST` stays off until its own audit passes).

**Verify `my targets` returns 3057 on the founder's phone before anything else.** Keep the logs
as the audit trail.

Then the scale gate, in order: weight-trend audit → onboarding cleanup (Slice 4b) → batch voice
truncation → grocery adjustment → per-client number prefs → presentation layer.

Polish, not a blocker: a prompt fragment leaks into the targets reply — *"You're doing great on
tracking! specific. 👌"*.

### THE MATH IS LYING BY ONE NUMBER — next session, top, nothing in front of it

**`maintenanceKcal`'s activity multiplier ignores training.** `office: 1.3` is sedentary-with-no-
exercise; a client training 3x/week is ~1.55. So maintenance is understated ~380 kcal for EVERY
client, and every target in the product is built on it.

That one number explains two separate "findings" from the 2026-08-05 audit:
- muscle_gain read as maintenance (+19 over Mifflin) — the goal adjustment is ALREADY +400 and
  was never the bug; it was landing on an understated base.
- fat_loss read as a crash diet (-781) — intended -400, plus the same -381 understatement.

    maintenanceKcal(83kg, male, 30y, 175cm, office, 3 days) = 2376
    Mifflin BMR 1779 x 1.55 (moderate)                      = 2757   gap: -381

**APPLY IN THIS ORDER. The order is the whole point** — every later number multiplies this one.

1. Fix the activity multipliers so training days are counted. VERIFY maintenance ~2757 for the
   founder's profile (83kg, male, 30y, 175cm, office, 3 days) before going further.
2. Then the goal adjustments: `muscle_gain` +300 default (+400 a per-client option for hard
   gainers and stalls), `fat_loss` -500 and always above the BMR floor.
3. Then `stepBurnKcal` to the standard ~0.5 kcal/kg/km, and delete the "~237 kcal burned" text.
4. VERIFY, and report these three exact numbers as work:
   founder's target **3057** · a fat_loss client at 80kg **TDEE-500** · 5000 steps @83kg **~166**
5. ONLY THEN the weight-trend auto-adjust audit — it multiplies whatever maintenance says, so it
   is meaningless until the base is true. Test +0.5kg/week observed: does it dampen, or oscillate?

**BLAST RADIUS — apply atomically, never half.** Correcting the multiplier raises EVERY client's
target at once, including the two live ones. That is the correction (fat-loss clients get safer
calories, gain clients get a real surplus) but it is a sudden ~380 kcal jump. One commit, verified,
or not at all.

Then, in order: grocery adjustment → per-client presentation (the numbers question asked at
onboarding, cards on a weekly beat plus milestones, buttons on QUESTIONS only, never on a receipt)
→ Slice 4b (onboarding's 51 mouths are a new client's first impression) before the 10 beta users.

Still open and unfixed: long voice notes truncate; `LOG_STEPS` has no retro field so steps cannot
be logged to yesterday.

### THE REBUILD — 5 slices, one per session (founder spec, locked 2026-08-04)

One brain, silent hands. The engine is the only file that speaks to a client about their logs.

| Slice | What | Gate | State |
|---|---|---|---|
| 1 | `shadow_replies` staging table + the CI gauntlet | Gauntlet runs RED on current code, proving it detects the known defects | ✅ **done 2026-08-04** |
| 2 | Multi-intent parser + silent tools (JSON only, no text) | Slice 2's gauntlet column turns green | next |
| 3 | Prompt enforcement + engine-fed card, old dashboard card deleted | Slice 3's column turns green | |
| 4 | Delete every handler reply send; `authorship:` 532 → ~5 | Slice 4's column turns green | |
| 5 | Live flip — shadow off, founder sends 3 messages, then 10 beta users | **Fully green gauntlet** | |

`npm run gauntlet`. Today it reports: slice 1 **12/12**, slice 2 5/10, slice 3 25/54, slice 4 0/1.
Wired into CI as reporting-only; **Slice 5 deletes the `continue-on-error:` line in test.yml.**

Two things to be straight about before slice 4 is planned:

- **The authorship floor is ~5, not 3.** The count is a regex over `return "…"` in `server/` +
  `shared/`, so it also catches helpers that return a bare string and never reach a client.
  Three mouths (engine, crisis, never-silent fallback) is the intent; chasing the last two
  is not worth a session. The gauntlet asserts ≤5.
- **Shadow mode has one deliberate hole: crisis.** `SHADOW=on` withholds everything else, but a
  reply carrying the SADAG number still sends. A helpline held back because a build was in
  staging is not a trade this product makes. The row is still written, so the record is complete.

### THE ONE-MIND CHANGE — folded into slices 2-4 above

**The coach is excluded, by design, from the interaction clients do most.**
`mustStayDeterministic` returns `true` for every log — food, steps, weight, water, "done" —
and `true` means the engine never sees the message. So the brain that holds his voice, their
seven days and what they said yesterday only speaks when someone asks a *question*. The moment
a client does the thing this product exists for, the coach is routed around and machinery
answers with numbers. That is why it reads as a calculator.

The reason it was built that way has since been dismantled: tools are silent by type (Guard #8)
and the number brake refuses figures the client never said. The guard rails now exist; the
exclusion is still standing.

**Ship in ONE session, gate and prompt in the SAME commit. No flag.**
The gate decides WHO answers; the prompt decides WHAT they say. Flip the gate alone and the
engine prints the same receipt in its own name — the disease changes seats. Two owners, one
sentence, one commit.

1. **PROVE THE PROMPT FIRST, offline.** Replay three inputs — a food photo, "5000 steps", the
   two-turn yesterday — and confirm the engine writes a COACHING sentence: one line, their
   words, one next move. Not a confirmation, not a breakdown. If it writes a receipt, fix the
   prompt before touching the gate.
2. **Then flip** `mustStayDeterministic` to false for the log actions.
3. **Then DELETE the handler reply sends** — delete, not comment. `authorship:` must fall.
   If the number does not move, the mouths did not die.
4. **Acceptance is the screenshot, not the suite.** Those same three, live, in his hand.
   A photo of breakfast must come back as a human sentence with one next move.

Crisis stays deterministic and pre-engine. The provenance gate stays — it caught "6,000 steps
he never walked". Those two are not scaffolding; they are the reason a fluent coach cannot
invent a client's history.

### Serves the 1 September date
| # | Item | Origin | State |
|---|---|---|---|
| 1 | **Voice-note replies, opt-in** — `voice:on`, triggered by "talk to me" or "I can't read"; auto-OFFERED after three inbound voice notes, never auto-enabled. Audio rides alongside the text, never replaces it. | Reviewer #1, item 8 | ✅ shipped 2026-08-03 |
| 2 | **Bulk intake** — one paste becomes a filled profile, with a hallucination brake and an FSM jump. `BULK_INTAKE=off` to kill. | Founder: "they send bundles" | ✅ shipped 2026-08-03 |
| 3 | **Photo-meal coaching voice** — a photo now gets two words, a question, or one portion fix. | Own audit | ✅ shipped 2026-08-03 |
| 4 | **Delete handlers the engine has replaced.** 29 message deciders, unmoved since the hoist. 3 files still AT RISK: `early-commands.ts`, `advice-commands.ts`, `misc-commands.ts`. | Harsh reviewer, 2026-07 | **OPEN — the honest gap** |

### After launch, not before
| # | Item | Origin | State |
|---|---|---|---|
| 5 | Repair-rate metric — messages-to-resolution after confusion. Better pilot signal than raw retention. | Reviewer #1, item 6 | queued |
| 6 | Shadow-mode brain, sampled 2–3% (not 100% — that doubles LLM cost) | Reviewer #1, item 9 | queued |
| 7 | Provenance-gate regexes → move onto the engine's structured output, which already parses all three claim kinds | Architecture debt, declared | owed |
| 8 | Traffic-light emoji consistency across all verdicts | Reviewer #1, item 3 | partial |
| 9 | Merge looksLikeStepsReport / WaterReport / WeightReport into one parameterised report predicate — three coats on one question, ~30 call sites | Noticed paying for bulk intake | owed |

### Needs a human, not a model
- **Sesotho and Setswana food aliases need a native-speaker check.** 144 aliases shipped; the
  Nguni ones are solid, the Sotho-Tswana ones are my best reading and have never been checked
  by someone who speaks it. One afternoon with the right person removes the whole risk.

### Founder decision, flagged not shipped
- **Referral reward:** friend gets a 14-day trial instead of 50% off. Protects price
  perception. Reviewer #1 item 10 — a pricing call, not mine to make.

---

## The one that is not a task

Two real users are in production. Every question about retention, pricing and fatigue is
unanswerable at two and starts answering itself at twenty. Nothing on either list above
matters more than that number moving.
