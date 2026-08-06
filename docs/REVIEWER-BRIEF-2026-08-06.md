# KamLife Coach — Reviewer Brief, 6 August 2026

Written for outside reviewers. Everything here is measured from the code and the test
suites, not estimated. Where a number cannot be measured from this machine — anything
about **real client usage** — that is stated plainly rather than guessed.

---

## 1. What the core product does

A person on WhatsApp sends what they ate, in their own words, and gets coached.

    "pap and chicken"        → logged, one line back
    a photo of their plate   → identified, logged, one line back
    a voice note             → transcribed, logged, one line back
    "I did 5000 steps"       → "5 000 steps — nice one. 👌"
    "I trained this morning" → session banked, next lift named, one question asked

Around that loop sit: a training programme that progresses, daily/weekly check-ins, a
weight and progress record, and a safety layer (crisis routing to SADAG, injury and
medical guards). R199/month. No app, no download.

**The pitch is one sentence: talk to it like a person and it does the maths.** That is
genuinely the interface — the deterministic handlers below are a safety net under a
conversational front door, not a command language the client has to learn.

---

## 2. Is it simple? Honest answer: the experience is close, the codebase is not

### The client-facing experience — much simpler than it was this morning

Today's work swept **every** client-facing reply path and cut the walls. Concrete
before/after, all measured on real replies through the real pipeline:

| Path | Before | After |
|---|---|---|
| Workout done | 3 paragraphs on cortisol and glycogen + comeback note + 6-line target table + 3-button menu | Confirmation + the next lift + "How did that session feel?" |
| "what should I eat for lunch" | 2 031-character three-day meal plan | 2 sentences naming food |
| Rest day | 655 characters, 17 sentences, a 4-item checklist | 2 sentences |
| Being ill | Bulleted protocol sent to someone in bed | 3 lines |
| Goal reached | 10 lines and a numbered form | 1 celebration + 1 question |
| Supplements (creatine) | 462 characters, 12 sentences | Verdict, dose, where to buy |
| `menu` / `help` | 564 characters **and two button menus** (the second rendered as literal text — a live bug) | One menu, one set of buttons |

### The codebase — not simple, and this is the finding that matters

Measured today:

- **76 962 lines** of TypeScript
- **234 modules**, 29 handler files
- **259 named feature blocks** across the handlers
- **443 places** other than the coaching engine that can put words in front of a client
- **330 named regex patterns**; **30 files** hold an opinion about what a message means
- **18 direct Twilio call sites**

The product a client experiences is one loop. The code behind it is 259 features. That
gap is the whole story of this brief.

---

## 3. What was built today

### 3.1 "Can I eat this?" — a grounded verdict from a label

`productVerdict()` reads kcal, sugar, saturated fat and protein off a nutrition panel and
answers the way a coach answers by hand: yes or no, how often, how much. `compareProducts()`
puts two labels side by side (saturated fat, then sugar, then calories) for the
margarine-aisle question. **An unreadable label returns nothing rather than a guess.** The
same pie reads differently on muscle-gain than on fat-loss, because it is different.
7 tests, from real client screenshots.

### 3.2 The path sweep — the end of whack-a-mole

The workout reply shipped a wall because the training domain was never on the list of paths
we had cleaned. **The list was the bug.** Fixing paths one at a time means the next one is
found on a client's phone.

So the paths are now enumerated and enforced:

- **`npm run probe`** fires 40 real messages through the live pipeline under production
  flags and reports the shape of every reply — length, sentence count, walls, stray menus.
- **Gauntlet Slice 5** turns that into **244 assertions**: one row per path, each with a
  sentence budget and *a written reason it gets that budget*. A workout listing is allowed
  to be long because the client asked for the exercises; a confirmation is not.
- Adding a reply path without adding a row is how the next wall ships. The table is the
  thing that has to be maintained now, and it is small enough to read.

Rules now enforced mechanically on every path: no receipts, no walls, **buttons only ever
answer a question that was actually asked**, and no physiology lectures (cortisol, glycogen,
endorphins, protein synthesis — all now build failures in a coaching reply).

### 3.3 The physique read — a feature that had never once run

`onboarding-physique.ts` was written on 17 July to prevent the worst mistake this product
can make: **putting someone who needs a surplus onto a deficit.** It reads 1–3 body photos,
estimates body composition, and when the body disagrees with the goal the client picked, it
recommends the other one and lets them decide.

**Nothing in the product ever set the state that triggers it.** The state was read in one
place and written nowhere. No client has ever been asked for a photo; the module has never
executed. Five unit tests passed the entire time because they called the pure functions
directly and never asked whether anything reached them.

Now wired, with the POPIA protections:

- **Optional**, and the coaching works identically without it.
- **Four disclosures on screen before any photo can exist** — purpose, who can see it, that
  an AI reads it *and that the read is an estimate rather than a measurement*, and the
  deletion right. There is no path to the photo step that skips this text.
- **The photo never decides alone.** It is combined with the client's stated goal and the
  maths. On a mismatch the bot recommends and asks; **the client's choice always wins.**
- **`delete my photos`** is now a real command. Before today the only way to remove a body
  photo was to delete the entire account — which is not a right. It deletes immediately,
  with no confirmation ceremony, because friction on a privacy right makes the right
  theoretical.

---

## 4. What should be REMOVED — the reduction case

### 4.1 The free deletion: ~30 handler branches that are already dead in production

`ENGINE_LIVE=on` is global for all clients. **30 handler branches are gated behind
`ENGINE_LIVE !== "on"`, which means they cannot execute in production today** — not "rarely
run", *cannot run*. They are:

`advice-commands.ts` (25 of them — alcohol, foods-to-avoid, binge recovery, logging
confession, nibbling, chronic under-eating, deferring start, results timeline, shift worker,
inactive gym member, belly fat, bereavement, load shedding, crime/walking objection,
month-end, gains fear, low mobility, food dislike, overtraining plan, defeated-no-results…)
and 5 more in `misc-commands.ts`.

That is **414 lines in one file alone**, plus their tests, plus their share of the 330
regexes and 443 mouths. **This is the safest cut available: proven unreachable by a flag,
deletable with no behaviour change.** The engine already answers all of these.

**Recommendation: delete them.** Keep the flag itself as the revert path for one more
release cycle, then remove the flag too.

### 4.2 Features to question — but measure first, and I cannot measure them from here

The following exist and are, to my reading, far from the core loop. **I have no access to
production usage from this environment, so treat this as a list to check, not a verdict:**

- Accountability buddy system / find-a-buddy / challenge-a-friend
- Weekly step leaderboard (anonymous competition)
- Badges and achievements
- Fasting tracker
- Supplement tracking (distinct from the supplement *guide*)
- Body-recomposition tracker, clothing check-ins, weight-trend charts
- Shopping-list generator and pantry detection
- Daily fact / tip / "did you know"
- Diet break, week-9 path choice, social-event and braai guides

**Run this query first** — it is the honest instrument, and it takes a minute:

```sql
SELECT intent, COUNT(*) AS uses, COUNT(DISTINCT user_id) AS clients
FROM chat_history
WHERE created_at > NOW() - INTERVAL '60 days'
GROUP BY intent
ORDER BY uses DESC;
```

Every reply is logged with an intent. **Anything with fewer than ~3 distinct clients in 60
days is a feature the product is paying for and nobody is using.** Cut on that evidence, not
on instinct — including mine.

### 4.3 The structural recommendation

The reason this codebase has 259 features is not that anyone chose 259 features. It is that
each one was locally reasonable, and until recently **nothing in the build ever said no.**
There are now governors that do say no (module count, regex count, message deciders,
authorship points, file sizes, Twilio call sites — all frozen, all may only fall). They work:
they blocked me twice today and forced four consolidations before I was allowed to add three
lines of legally-required consent text.

**Keep them. They are the most valuable thing in the repository after the test suites.**

---

## 5. Is it hassle-free?

**For the client: close, and much closer than this morning.** Send words, a photo or a voice
note; get a short human reply. Onboarding asks only what changes the maths. Nothing needs to
be learned or installed.

**Two honest caveats:**

1. **The physique read has never run for anyone** (§3.3). It is wired today, and *today* is
   the first day the goal sanity-check exists in practice. It needs watching on real signups.
2. **Verification still depends on the founder's phone for anything involving the AI model.**
   The offline suites — 922 unit, 315 routing, 161 gap, 244 sweep assertions — prove routing,
   shape and determinism without a network. What they cannot judge is whether the model's
   *words* are good. That tier exists (`GAUNTLET_LLM=1`) and needs to run on a schedule
   against real traffic, not on demand.

---

## 6. Current state of the suites

```
unit-tests        922/922      integration        38/38
food-scanner       48/48       safety-audit       82/82
routing-audit    315/315       gap-tests        161/161
phrasing-battery   49/49       golden-regression  green
onboarding-e2e     3 signups end-to-end
gauntlet: slice 1 14/14 · slice 2 12/12 · slice 3 70/70 · slice 4 3/3 · slice 5 244/244
architecture guard: 234 modules, 330 regexes, 30 deciders, 27 cron jobs — all at budget
```

Three budget raises are on record, each dated, each with what was tried first and how it gets
paid back. They are printed on every single build so they cannot be forgotten.

---

## 7. The three things I would ask a reviewer to push on

1. **Run the usage query in §4.2 and delete on the evidence.** The reduction instinct is
   right; the evidence for *which* features should be data, not taste.
2. **Delete the 30 dead branches in §4.1 this week.** It is free, it is safe, and every week
   they stay is a week someone maintains code that cannot run.
3. **Ask why the physique read sat inert for three weeks with passing tests.** The answer —
   tests that call functions directly can never tell you whether anything calls the
   function — almost certainly applies to more than this one feature, and that is the
   question most likely to find the next silent hole.
