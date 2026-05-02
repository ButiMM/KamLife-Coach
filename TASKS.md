# KamLife Coach — Build Tasks

> Maintained by Claude. Read this at the start of every session.
> Updated after every session with what's done and what's next.

---

## CRITICAL BUGS (live clients affected)

- [x] Sick clients receive workout/celebration messages — fixed milestone, early onboarding, friday, week3 jobs
- [x] Payment link sent when client says "I'm not paying for this nonsense"
- [x] NPS "0" rating not captured (bare numbers not handled)
- [x] Streak-at-risk fires when client is sick
- [x] Evening check-in fires when client is sick
- [x] Morning check-in ignores yesterday's sick status

---

## FEATURES BUILT (merged to branch)

- [x] ElevenLabs voice clone integration (Voice ID: hxxP6qQTRvCaZJpq6uJH)
- [x] Weekly streak protection job (5pm UTC daily)
- [x] Step leaderboard job (Sunday 4am UTC)
- [x] Milestone celebrations job (6am UTC daily)
- [x] Evening accountability rewrite — conversational, not spreadsheet
- [x] Banned phrases enforced in guardrails (20 patterns)
- [x] STRONG_FRUSTRATION single-signal intercept
- [x] GPT frustration context rewrite — real data, 2-sentence cap
- [x] NPS survey moved to 3rd of month 7pm
- [x] Exercise GIF infrastructure (`server/exercise-media.ts`)
- [x] Portion poster infrastructure (breakfast / lunch / dinner)
- [x] `[MEDIA:url]` TwiML marker — WhatsApp inline image/GIF support
- [x] "show me [exercise]" command → sends GIF
- [x] "portions" / "lunch portions" / "dinner portions" command

---

## TODO — USER ACTIONS REQUIRED (you must do these)

- [ ] **Upload exercise GIFs** to your server/CDN:
  - Set `MEDIA_BASE_URL=https://your-domain.com` in environment
  - Upload GIFs to `MEDIA_BASE_URL/ex/` using filenames from `server/exercise-media.ts`:
    - squat.gif, bench-press.gif, lat-pulldown.gif, rdl.gif, shoulder-press.gif
    - hip-thrust.gif, incline-press.gif, cable-row.gif, split-squat.gif, face-pull.gif
    - leg-press.gif, goblet-squat.gif, sumo-squat.gif, hack-squat.gif, ohp.gif
    - leg-curl.gif, tricep-pushdown.gif, single-arm-row.gif, hip-abduction.gif
    - cable-kickback.gif, hammer-curl.gif, bicep-curl.gif, lateral-raise.gif
    - calf-raise.gif, push-up.gif, plank.gif, glute-bridge.gif, lunge.gif
    - reverse-lunge.gif, jump-squat.gif, mountain-climbers.gif, table-row.gif

- [ ] **Upload portion poster images** to `MEDIA_BASE_URL/portions/`:
  - breakfast.jpg — plate showing ½ veg, ¼ protein, ¼ carbs (breakfast)
  - lunch.jpg — plate showing ½ veg, ¼ protein, ¼ carbs (lunch)
  - dinner.jpg — plate showing ½ veg, ¼ protein, ¼ carbs (dinner, smaller carbs)

---

## TODO — CODE (next to build)

### High Priority
- [ ] **Sick state persistence**: when client says "still sick", bot should remember
  across the whole day — currently each proactive job re-checks chat history
  (works), but the morning check-in doesn't detect SAME-DAY sick (fires at 6am
  before client says anything). Add a `sickUntil` DB column or a daily sick flag
  so the app can carry state forward even when client hasn't messaged yet today.

- [ ] **Morning check-in — sick acknowledgment**: if client was sick yesterday,
  morning message should ask "How are you feeling today?" NOT push workout/streak.
  Currently it softens the message but still mentions sessions. Make the sick path
  a separate short message: "How are you feeling today? Let me know when you're
  ready and we pick up exactly where we left off."

- [ ] **Voice note scalability**: currently generates ElevenLabs voice for every
  client in a loop. At 100+ clients this will hit rate limits and take minutes.
  Need: queue system or send voice only to clients who engaged with voice before.

### Medium Priority
- [ ] **"Still sick" multi-day detection**: if client says sick 2+ days in a row,
  bot should send a recovery check-in ("Day 3 — how's the fever? Drink water, eat
  small, and message me when you're ready") rather than just skipping messages.

- [ ] **Workout GIF on programme delivery**: when client types "workout" or "1",
  attach primary exercise GIF. Currently wired up but needs MEDIA_BASE_URL set.
  Test this once GIFs are uploaded.

- [ ] **Portion poster at onboarding**: after onboarding completes, send breakfast
  portion image as a follow-up message (currently only hints via text). Wire up
  the `sendWhatsApp` call after the onboarding return.

- [ ] **Client preference: GIF vs YouTube**: some clients want YouTube links, some
  want GIFs. Add `visualMode` boolean to users schema. Visual mode clients get GIF
  attached + no YouTube links. Others get YouTube links as before.
  Schema: `visual_mode boolean default false`

### Low Priority
- [ ] **Supplement reminder**: parse actual supplement name from logs (currently
  uses generic "your supplement"). Improve the lookup query.
- [ ] **Payday shopping nudge**: remove hardcoded prices, make goal-aware.
- [ ] **Weekly recap voice**: low-engagement clients get text, high-engagement get
  voice recap. Currently sends voice to all.

---

## KNOWN QUIRKS (not bugs, just watch)

- FEMALE_DAY_A/B/C are hardcoded strings with YouTube links — GIF system doesn't
  touch these yet. If user wants GIFs for female programme, that's a separate task.
- `PORTION_GUIDE` in constants.ts (old generic one) and `EXERCISE_PORTION_GUIDE`
  in exercise-media.ts (new per-meal one) coexist. Old one fires on "how many
  grams" / "serving size". New one fires on "portions" / "plate guide". No conflict.
- The `[MEDIA:url]` marker only works on the FIRST part of a multi-part message.
  Long workout messages get split — GIF attaches to part 1, which is correct
  (client sees image first, then rest of workout text).

---

## SESSION LOG

| Date | What was done |
|------|--------------|
| 2026-05-02 | Sick detection added to milestone, onboarding, friday, week3 jobs |
| 2026-05-02 | Exercise GIF + portion poster infrastructure built |
| 2026-05-02 | [MEDIA:url] TwiML support, "show me X" and "portions" commands |
| Earlier | ElevenLabs, streak protection, step leaderboard, guardrails, NPS, payment fix |
