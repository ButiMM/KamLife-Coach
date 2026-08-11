# P2 — Coaching Quality Measurement

**Status: P2-A complete. Waiting for founder calibration.**

---

## AMENDMENT — 2026-08-11: real client data, and the two phases

The original brief §2 said "do not use real client records for this phase." That rule was too
blunt, and the founder corrected it. Recording the correction here, because a rule that lives
only in a conversation is folklore.

> **Real client data is the ultimate validation source, but it enters the measurement system
> deliberately, lawfully, and with privacy controls.**

The reason for the original constraint was privacy and measurement discipline — *don't casually
dump real client data into an AI evaluation pipeline*. That is not the same as *real client
conversations are forbidden*, and collapsing the two is counterproductive. An instrument
calibrated only on synthetic scenarios, constructed test users and the founder's own messages
measures Coach K against a member who helped design the test. It will certify a product that
works beautifully in a laboratory and then meets five hundred real South Africans saying things
no test suite imagined.

### Phase 1 — safe calibration (current)

The founder's own Coach K conversation establishes the initial rubric. No client data.

### Phase 2 — real-world validation (BLOCKED)

Properly handled real member conversations test whether the rubric survives reality. The
question Phase 2 exists to answer: **where does Coach K fail when confronted with people who
did not help us design the test?**

**Phase 2 is blocked until the questions below are answered.** Pseudonymisation is explicitly
NOT sufficient on its own and must not be treated as if it were — see the note under the list.

- [ ] What is the lawful basis for processing member conversations for AI evaluation? Is it
      covered by the existing KamLife privacy/consent notice, or is additional consent required?
- [ ] What must be removed, and is removal even achievable for this data?
- [ ] Who has access to the evaluation corpus?
- [ ] How long is it retained, and what triggers deletion?
- [ ] Does it stay local and gitignored? What, if anything, is ever committed?
- [ ] Is any part of it ever sent to a third-party model?

**Why redaction is not enough here.** Stripping names and phone numbers is trivial and is not
de-identification for this data. A weight-loss conversation is identifying in its *content* — a
suburb, a workplace, a medical condition, a named family member, a distinctive phrase. Remove
the name and the conversation still identifies the person to anyone who knows them. The honest
posture is therefore pseudonymised, local, access-controlled, retained for a fixed window, and
never committed — not "redacted, therefore anonymous."

**A load-bearing property to preserve.** The instrument currently makes **no model call and no
network call at all** — parsing, one shipped regex predicate, string comparison. The corpus
cannot leave the machine. That is what makes the Phase 2 answer to "is it ever sent to a
third-party model?" a structural *no* rather than a promise. If P2-C ever adds model-assisted
scoring, that property dies, and it must die by explicit decision rather than as an
implementation detail nobody noticed.

### Deferred — the manual-vs-AI comparison

The founder's own hand-coaching conversations with real members are a separate and potentially
very valuable analysis: what does a human coach do that Coach K does not — the better follow-up
question, the thing remembered, the challenge instead of agreement, knowing when not to advise.

It is a **different instrument** from P2, and it carries one trap that must be designed out
first: the samples are not comparable. A human coaches by hand when a member is engaged, paying,
or in trouble; Coach K handles everything including the dull 6am log. An unmatched comparison
flatters the human by construction and teaches nothing. **Match on situation or do not run it.**

The instrument is built and scores nothing. That is not an unfinished state — it is the
designed one. Brief §10 puts human calibration before automated scoring, and §12 forbids the
system that writes the replies from being the authority on whether they are good.

## The three commands

```
npx tsx script/p2-instrument.ts              # status: what is measurable, what is locked
npx tsx script/p2-instrument.ts --calibrate   # emit the calibration sheet from the corpus
npx tsx script/p2-instrument.ts --baseline    # refuses until the anchors exist
```

## P2-B: what you need to produce

**Ten conversations, deliberately varied** — not ten random chats. The point is not statistical
significance; it is exposing the range of situations KamLife actually has to handle, so the
anchors cover more than the easy middle.

| type | what it is |
|---|---|
| `ordinary_food_log` | the everyday turn — most of the product's volume |
| `correction` | "actually that was yesterday", "it wasn't rice" |
| `eating_out` | a restaurant or takeaway decision |
| `budget_constraint` | what to buy on R300, what the shop didn't have |
| `craving` | wants a specific food and is asking, not reporting |
| `missed_workout` | a setback — the accountability test |
| `emotional` | frustrated, flat, or admitting something hard |
| `messy_voice_note` | run-on transcription, several things at once |
| `refuses_to_log` | wants advice, not a food diary |
| `hard_coaching_call` | you knew what the right answer was, whether or not Coach K found it |

That last one matters most. A conversation where you personally know what the right coaching
response should have been — even if Coach K's answer was poor — is the most valuable anchor in
the set, because it defines the standard rather than merely rating what happened.

Declare the type of each file in `p2-work/corpus/manifest.json`:

```json
{ "conversations": [
  { "file": "01-log.txt",  "type": "ordinary_food_log" },
  { "file": "02-fix.txt",  "type": "correction" },
  { "file": "10-hard.txt", "type": "hard_coaching_call",
    "note": "what I think the right answer was" }
]}
```

Types are **declared, never inferred**. A classifier deciding what a conversation is about would
be the instrument choosing its own exam. Missing types are named loudly but do not block — a
sheet for eight types beats no sheet while the other two are found.

## Getting conversations in

Drop files into `p2-work/corpus/`. Two formats, both unedited:

**WhatsApp export** (`.txt` from WhatsApp's own Export Chat). Set the coach's exact sender name —
the adapter refuses to guess which side is Coach K, because getting that backwards would invert
every score and never announce itself:

```
P2_COACH_SENDER="Coach K" npx tsx script/p2-instrument.ts --calibrate
```

**Pasted transcript** — one speaker label per line, `Member:` and `Coach:`.

`p2-work/` is gitignored. It holds real conversations — food, weight, setbacks, moods — and a
git history is forever. The corpus is input to the measurement, not part of the product.

Do not edit messages to make them easier to score (§2). The typos, the code-switching, the
voice-note artefacts and the half-finished sentences are the signal: they are the conditions
Coach K actually has to work in.

## What runs today, without any anchors

| Check | Source | Status |
|---|---|---|
| Ends with a hand-back question | `endsWithHandback` in `server/reply-hygiene.ts` — the shipped predicate, reused not rebuilt | Runs |
| Verbatim repeat of an earlier reply | Normalised string equality within a conversation | Runs |
| Continuity provenance | Turn Ledger `state_read` / `mutations` | **UNAVAILABLE** |

Continuity is the honest gap. §5 wants it checked against stored state rather than reviewer
preference, and that needs the Turn Ledger — which a WhatsApp export does not carry. The
instrument reports this as unavailable rather than substituting a heuristic and calling it
provenance. A guess dressed as a machine check is worse than no machine check, because it looks
like evidence. **Continuity is human-scored for this baseline.**

If a controlled database export is approved later, it becomes one more adapter into the same
canonical format and the provenance check lights up. Nothing else changes.

## The anchor store

`docs/p2/anchors.json` is tracked and starts empty. It is the rubric — an untracked rubric is
folklore. There is no seed function and there must never be one: an example written by the thing
being measured is not evidence of anything.

`assertScoreable()` throws for any dimension without anchors at levels 1, 3 and 5. There is no
override flag, on purpose — a flag would get used once "just to see the shape", and that run
would become the baseline everyone quotes. Four assertions in `script/unit-tests.ts` make
removing the lock a red build.

Per §11: when a conversation exposes a genuine scoring ambiguity, **add the case** to
`ambiguities` rather than editing the rule. That is how a rubric keeps its meaning instead of
drifting into whatever is convenient, one reasonable-looking edit at a time.

## Sequence

- **P2-A — instrument.** Done.
- **P2-B — calibration.** Selection machinery done; **waiting on the corpus.** Founder hand-scores
  ~25 selected turns from ten varied conversations; agreed examples become the anchors. ← next

### How the ~25 turns get chosen

`--calibrate` selects for **spread, not volume** (`--turns N` to change the quota). It spans the
axes a machine can see — verbatim repeats, long replies, hand-backs, terse replies, turns
answering a long member message, and ordinary turns — and it explicitly cannot see which replies
are good, cold, or context-aware. That is the judgement being calibrated; if the selector could
make it, the sheet would be pointless.

Two rules keep the sample honest, both of them regression-tested:

- **No stratum takes more than half the sheet.** The first draft filled 14 of 25 seats with
  hand-backs, which produces a sheet about one defect rather than about coaching.
- **Every conversation is represented before any is sampled twice**, so the longest chat cannot
  crowd out the other nine types.

Selection is reproducible — no randomness. The same corpus yields the same sheet, because an
instrument whose sample shifts between runs cannot be argued with.
- **P2-C — baseline.** Distributions and failure clusters. Not built: how to score follows from
  what calibration reveals, not the other way round.
- **P2-D — adjudication.** Which failures are worth fixing.
- **P2-E — intervention.** Only now does Coach K change, each change naming its measured failure.
- **P2-F — re-measurement.** Same framework, like for like.

§14: the first run finds **clusters, not scores**. A 3.4 against a later 3.7 proves nothing
without a comparison design built for it.
