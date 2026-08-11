# P2 — Coaching Quality Measurement

**Status: P2-A complete. Waiting for founder calibration.**

The instrument is built and scores nothing. That is not an unfinished state — it is the
designed one. Brief §10 puts human calibration before automated scoring, and §12 forbids the
system that writes the replies from being the authority on whether they are good.

## The three commands

```
npx tsx script/p2-instrument.ts              # status: what is measurable, what is locked
npx tsx script/p2-instrument.ts --calibrate   # emit the calibration sheet from the corpus
npx tsx script/p2-instrument.ts --baseline    # refuses until the anchors exist
```

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
- **P2-B — calibration.** Founder hand-scores. Agreed examples become the anchors. ← next
- **P2-C — baseline.** Distributions and failure clusters. Not built: how to score follows from
  what calibration reveals, not the other way round.
- **P2-D — adjudication.** Which failures are worth fixing.
- **P2-E — intervention.** Only now does Coach K change, each change naming its measured failure.
- **P2-F — re-measurement.** Same framework, like for like.

§14: the first run finds **clusters, not scores**. A 3.4 against a later 3.7 proves nothing
without a comparison design built for it.
