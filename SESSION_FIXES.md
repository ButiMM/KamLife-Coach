# KamLife Coach — Bug Fixes (Session Summary)

## Bugs Fixed

**1. "No gym" users got Brisk Walk instead of a real workout**
Anyone who said "no gym" or "no equipment" during onboarding was assigned walk-only mode and received "Brisk Walk — 15 minutes" as their entire programme. Fixed so they now get a full bodyweight home programme.

**2. "I need more" went to GPT chat instead of updating the database**
When a user said "I need more", the bot asked the right questions but never saved anything. The user's programme in the database was never changed. Fixed so "I need more" now triggers the real programme builder and writes to the database.

**3. ✏️ emoji sent as a real WhatsApp message**
The bot was sending a literal pencil emoji as a standalone message before every GPT response. Removed entirely.

**4. Programme rebuild didn't show daily targets**
After rebuilding a programme, the delivery message didn't include calorie, protein, or step targets. Users had to ask separately. Fixed — targets now included in the delivery message.

**5. "I drank water" got no response**
If a user said "I drank water" without specifying an amount, the bot silently ignored it. Now responds: "How much? Tell me the amount — e.g. drank 500ml."

**6. Scheduler used wrong timezone**
The morning message job was checking the day of the week using UTC time instead of South African time (UTC+2). This caused the wrong training/rest day to be sent on date boundaries.

**7. PROACTIVE_PAUSED didn't stop all messages**
The global pause switch was not applied to cultural messages (Public Holidays, Women's Month, New Year) or milestone messages (30/60/90-day check-ins, referral nudges). Paused users still received these. Fixed.

**8. Reset command crashed with "something went wrong"**
The reset flow deleted the user record before deleting linked data, causing a database foreign key violation. Fixed by deleting all dependent records first.

**9. POPIA consent swallowed food messages**
The consent keyword "ja" matched any message containing "ja" — including "jam sandwich". This caused food messages to be treated as consent responses. Fixed with whole-word matching.

**10. Food photos silently dropped after steps screenshot**
The media deduplication window (10 seconds) was too wide. A step screenshot at 18:25 would block food photos sent at 18:26. Reduced to 3 seconds.

---

## Still Needs Doing (Non-Code)

- PayFast live R149 transaction test
- Set MEDIA_BASE_URL in Railway and upload exercise GIFs
- Trial system exists in the code but is never activated — users currently hit the paywall immediately with no trial period
