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

## STANDING ARCHITECTURAL LAW (added 2026-07-07 after the goal-flip disaster)

THE DISEASE (root of most failures this week): the model layer was allowed to
OVERWRITE known stored truth with a fresh guess, with nothing cross-checking the
guess against what the system already knew about the client.

THE LAW — no model output (normalizer canonical OR brain reply OR fallback) may
mutate a FOUNDATIONAL client fact without BOTH:
  (a) explicit client vocabulary for that change in the ORIGINAL message, and
  (b) an explicit confirmation that NAMES the current value before changing it.
Foundational facts: goalType, calorie/protein targets, programme phase,
currentWeight, subscription state.

Enforcement so far:
  - Goal: hasGoalChangeVocabulary brake (normalizer) + goal_confirm explicit-yes
    gate (lifecycle) + brain defers goal/target changes.
  - Weight: retrospective-weight brake (normalizer) already drops "used to weigh".
TODO to complete the law (audit each):
  - Targets: only the goal-change flow and the Sunday auto-adjust may write them;
    confirm no brain/fallback path claims to.
  - Phase advance: confirm it needs completion, never a chat inference.
  - A CONTRADICTION CHECK: when a model intent contradicts the stored goal
    direction (fat-loss talk to a muscle-gain client), flag/soften rather than obey.
    This is the general form of the fix and the highest-value next guardrail.
