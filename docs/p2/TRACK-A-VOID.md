# TRACK A — NOT BUILT. The defect does not exist.

**Status: Track A is withdrawn. No product code was changed.**

Track A was authorised to fix this:

> *"Multiple rapid voice notes can be transcribed/echoed without the member receiving a timely
> coaching response."*

**That finding was an artifact of my parser. Coach K answers voice notes.**

---

## What is actually true

Coach K returns the transcript echo and the coaching reply as **one WhatsApp message**, separated
by a blank line (`server/handlers/media.ts:1439`):

```
🎤 I heard: "So, for a pre-workout, I've just had a bowl of Cheerios and a switch energy drink."

Noted — bowl of Cheerios and a Switch energy drink for pre-workout 👌. How's the energy
feeling for your session?
```

Across the full 26,288-line export:

| | |
|---|---|
| transcript-echo messages | 350 |
| **carrying the coaching reply in the same message** | **349 — 100%** |
| echo with nothing attached | 1 |

The reply arrives with the echo, in the same message, within about 20 seconds.

## Two bugs, compounding

**1. The `HEARD` pattern ran to end-of-string.** `/^🎤\s*I heard:\s*"?([\s\S]*?)"?\s*$/` matched the
*entire* multi-line message and `isPipelineMessage()` therefore classified the coaching reply as
plumbing. Every voice reply in the corpus became invisible.

**2. The corpus files were written without their continuation lines.** The segmentation script
accumulated continuation text into a `text` field and then wrote out `raw` — the matched first
line only. So even after fixing (1), the reply text was not on disk to find.

Together these produced a finding that read as rigorous — "0 of 16 voice turns received a reply",
a 290-second silence window, a 20% delivery rate — and was entirely manufactured.

## What is withdrawn

- "All 16 recovered voice turns received no coaching reply." **False.** All 16 were answered.
- "20% / 50% / 58% voice reply rates." **False**, and they superseded an earlier 97% that was
  also wrong for a different reason. Three successive wrong numbers for the same quantity.
- "A 290-second window with no coach speech." **False** — replies were arriving throughout.
- "Voice-response delivery is a major product defect." **Withdrawn entirely.**
- The C4 candidate at V5 is also void: *"remove that meal"* did receive a reply.

## Corrected corpus, corrected numbers

| | |
|---|---|
| member turns | 111 (16 voice-transcribed, 2 image, 28 multi-part, 6 long) |
| coach turns | 143 — of which 27 pipeline, **114 scoreable** |
| infrastructure artifacts | 5/114 = **4%** (1 build artifact, 4 Twilio sandbox reconnects) |
| **truncated replies** | **0/114 = 0%** |
| C1 hands the work back | 8/109 = **7%** (still a floor — the predicate undercounts) |
| C3 verbatim repeat | 2/109 = 2% |

**Truncation is now zero.** The three "truncations" were also continuation-line losses. The one
survivor is `"I've got smart, goal-aware orders for these spots:"`, which remains genuinely
truncated and remains the cause of the anchored Understanding-1 failure.

**Reliability in this corpus is ~1% (one build artifact), not 4% and not 17%.** The four Twilio
errors are test-sandbox reconnection.

## What survives

The **coaching** findings, which never depended on the voice pipeline:

- The five founder-validated failure anchors, all confirmed at 1.
- C1 (hands the work back), C2 (generic when specific was possible), C3 (stock phrasing),
  C4 (invented state — the 83.3kg), C5 (accommodates without coaching the trade-off).
- The causal chain from the one real truncation to the Understanding-1 failure.

**Track B is unaffected.** Every requirement in it rests on replies that exist and were read
correctly.

## The process failure, stated plainly

Four parsing errors in sequence, each found only by tracing a claim to its cause:

1. `U+200E` prefix — media turns swallowed into the previous message.
2. Voice ack counted as a broken output → "17% infrastructure".
3. Dangling-colon truncation detector counting headers followed by their card image.
4. **This one** — the echo pattern swallowing the reply, plus corpus files written without
   continuation lines.

Only the fourth was load-bearing on a product change. The acceptance criterion I proposed in
MEASUREMENT-GAPS.md §6 — *"every reliability finding is traced to a cause before it is reported
as a rate"* — is the one that would have caught all four, and I did not apply it to my own
delivery finding until the moment before writing code.

**A regression test now pins each of the four.** `script/unit-tests.ts`, 981 passing.

## Recommendation

Track A has no work in it. **Go straight to Track B**, whose requirements stand unchanged.

The one genuine reliability item — the single truncated `"…for these spots:"` reply — is a real
defect with a real downstream cost, but it is one occurrence in 114 turns and does not justify a
track of its own. It belongs in `docs/BACKLOG.md` with the logging findings.
