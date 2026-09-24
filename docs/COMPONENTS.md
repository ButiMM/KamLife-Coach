# Every component: keep, reuse, replace or delete

The CTO's decision for each part of the codebase (server 74,888 lines on 24 Sep). Rule: **nothing gets rebuilt that already works, and nothing replaced stays alive.** Files marked for deletion are listed in `docs/delete-list.txt`, and the watch shows on #280 how many still exist. That number has to reach zero.

## 1. KEEP: plumbing that works (fix in place, never rebuild)

| Component | Files |
|---|---|
| WhatsApp transport and signatures | `routes/whatsapp.ts`, `outbound-delivery.ts`, `whatsapp-templates.ts`, `net-guard.ts` |
| Payments | `routes/payments.ts`, `scheduler/jobs/business.ts` (billing parts) |
| Database | `db.ts`, `storage.ts`, `shared/schema.ts`, `migrations/` (the only schema authority after #343) |
| Day maths | `day-ledger.ts`, `day-ledger-core.ts`, `sast.ts` (becomes the single day-boundary helper, #325) |
| Deterministic guards (tools, never speakers) | `handlers/safety.ts`, safety detection, opt-out, the age gate, the scope check in `understanding/domain-guard.ts` |
| Scheduler engine | `scheduler.ts`, `scheduler/shared.ts` (the send path) |
| Ops | `routes/health.ts`, `routes/auth.ts`, `cost-tracking.ts`, `index.ts` (slimmed by #343), `join-qr.ts` |
| Admin and Coach Health | `routes/admin*.ts`, `routes/coach.ts`, `routes/dashboard.ts`, `routes/finance.ts` (about 5k lines; slim when #293 lands) |

## 2. REUSE: knowledge and tools the new coach calls instead of rebuilding

The new coach (`server/core/`) **calls these**. It never re-implements them, and never asks the model for a number these can compute.

| Tool | Files |
|---|---|
| South African foods, portions, servings | `foods.ts`, `serving-units.ts`, `food-swaps.ts` |
| Calorie and protein targets, floors, adaptation | `targets.ts`, `adaptive-targets.ts` |
| Meal plans and shopping | `meal-plan.ts`, `onboarding-meal-plan.ts`, `shopping-lists.ts`, `grocery-personalize.ts` |
| Training | `programme.ts`, `exercise-variants.ts`, `exercise-media.ts`, `workout-feedback.ts` |
| Vision (plate, equipment, physique) | `handlers/food-scanner.ts`, `handlers/equipment-vision.ts`, `physique-analysis.ts`: consolidate behind one vision tool |
| Voice | speech-to-text plus `understanding/sa-transcript.ts` (cleaner), `elevenlabs.ts` |
| Progress and outcomes | `outcomes.ts`, `progress-score.ts`, `trajectory.ts`, `weekly-recap.ts`, `hunger-evidence.ts` |
| Education content | `education.ts` |
| Cards (for the look-and-feel phase) | `macro-card.ts`, `achievement-card.ts` |

## 3. REPLACE: deleted in the switch PR for its message family

| Old component | Replaced by | Deleted in |
|---|---|---|
| The 54 exits in `routeMessage` (`routes.ts`) | the composer | each #272 switch PR, per family |
| `handlers/misc-commands.ts`, `early-commands.ts`, `lifecycle.ts`, `food-context.ts`, `food-log-mgmt.ts`, `food-commands.ts`, `advice-commands.ts`, `numbers-literacy.ts`, `meal-repeat.ts`, `gpt-block.ts`, `sick-flow.ts` | understanding + composer (+ ledger tools for writes) | #272 switch PRs |
| Reply text in `handlers/weight.ts`, `steps.ts`, `water.ts`, `workout.ts`, `media.ts` | composer (their ledger writes stay) | #272 switch PRs |
| `gpt.ts` (`askCoachK`, the intent classifier, `selectModel`) | `core/coach.ts` | the last #272 switch |
| `one-action.ts`, `scheduler/proactive-decision.ts` | one decision authority in the core | #272 / #319 |
| Old Meaning Engine: `understanding/live.ts`, `meaning-engine.ts`, `perception.ts`, `actions.ts`, `executor.ts`, `messy-intake.ts`, `reentry.ts` | `core/coach.ts` | the last #272 switch |
| `brain/coach-brain.ts`, `brain/client-snapshot.ts`, `brain/reply-verifier.ts` | core composer + client record | #272 |
| Memory stores: `memory.ts` (six regex fields), `portion-memory.ts`, `held-constraints.ts`, `life-context.ts`, `health-state.ts`, `intelligence/profile.ts`, `client_understanding` | the client record (#271): one store | #272, as reads move |
| `coach-prompt.ts` (69k characters, sliced) | a short core prompt plus doctrine selected per turn | #320 |
| `onboarding.ts` conversation script | composer, journey 1 | #272 |
| Copy inside scheduled jobs (`scheduler/jobs/morning.ts`, `weekly.ts`, `monday.ts`, `programme.ts`, `onboarding.ts`), `unlogged-notice.ts`, `machine-coach.ts`, `agents.ts` | proactive decisions through the composer | #319 |

## 4. DELETE: layers that exist only to police other layers

With one composer, these have nothing left to police. Deleted when the last message family switches (sooner if dead):

`reply-hygiene.ts` · `outbound-authority.ts` · `reply-contract.ts` · `normalizer-fidelity.ts` and the in-place normaliser (#323) · `verifiers/meal-verifier.ts` · the provenance parts of `verifiers/response-gate.ts` (one slim final safety check survives) · `self-check.ts` · `audit/` · `drill-cases.ts` · `backfill.ts` (one-off) · `replit_integrations/` · `macro-card-attach.ts`

## Who makes sure

- **Claude Code** deletes each file in the switch PR that retires it, and removes it from `docs/delete-list.txt` in that PR.
- **The watch** shows on #280 how many listed files still exist. The mouth ratchet and the size target show the rest.
- **The CTO** reviews every `[core]` PR against this file: reuse, don't rebuild; replace, don't add.
- **Codex** attacks switch PRs with the old component's journeys.
