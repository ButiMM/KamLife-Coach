# Next session — start here (written 2026-07-07 ~02:45 SAST)

18 commits shipped on 6–7 July (trust engine, one-voice unification, guardrails
on the brain, remove_meal tool, phantom-copy guards, transaction bypasses,
midnight date-family fixes, memory + escalation + scenario knowledge +
proactivity in the brain, week card, drill battery). Full `npm test` chain green
at `5335125`. Verify with `npm test` and CHECK THE EXIT CODE — do not pipe it.

## Build queue (in order)

1. **Bulk intake ("one-paste onboarding")** — fully specced in
   `docs/bulk-intake-design.md` with a real client blob as the golden case.
   Requires a full read of `server/onboarding.ts` (never-touch-blind file) to
   implement the FSM jump. Flag-gate it (`BULK_INTAKE=on`), fail open.
2. **Photo-meal coaching voice** — the vision reply's coaching sentence
   ("Nice balanced meal!") is softer than Coach K. Align with the brain's voice
   rules in the media.ts food-vision prompt; preserve the goal-aware +
   grease-detection logic (CLAUDE.md warning applies).
3. **Dashboard failure** — blocked on Kam's Railway deploy-log screenshot
   (Users page + Business Health). Code side verified clean; suspect runtime.
   Also: dashboard says "ElevenLabs not connected" while Railway has both env
   vars — probably needs a redeploy to load them.
4. **0.57 vs 0.21 kg/week trace** — needs the Message Feed to identify which
   path emitted 0.57 on 2026-07-06 ~16:51. Rules now force exact quoting, but
   find the origin.
5. **Drill battery run** — `OPENAI_API_KEY=... npx tsx script/drill-battery.ts`
   (11 cases incl. the five evening failures). Needs a key; validates every
   prompt fix against the live model. Consider wiring into CI with a secret.

## Standing rules learned the hard way

- Run the FULL `npm test` chain before any push; capture the exit code
  explicitly (a piped tail once masked a red suite).
- Any date logic must anchor to `sastDayStart()` — the 00:00–02:00 SAST window
  broke "yesterday", day-names, and two tests. Suite now locks these.
- Transactions (food/steps/water/weight writes) are decided by CODE, never by
  the model. The brain coaches; deterministic paths log. Preflight regexes in
  utils.ts (`looksLike*Report`) gate the brain in routes.ts.
- Every tester failure becomes a drill-battery or offline-suite case in the
  same session it's found.
- Kam's human tasks live in HUMAN_TASKS.md (backup is 0a and still the single
  biggest risk in the company).
