# CTO Deep-Dive — What Testers Actually Do vs What the System Does

**Date:** 2026-07-16 · **Method:** every tester behaviour observed across this
build cycle (screenshots, live console runs, chat history, drill cases) mapped
to its code path, audited by the builder — not reported by the founder.
**Standing rule going forward:** the founder does not file bugs. The nightly
self-audit files weak exchanges to `quality_signals`; the builder reads that
queue every session and turns each one into a fix + regression case.

## 1. The demand map — what our people actually send (observed)
| Real behaviour (seen) | Code path | Status |
|---|---|---|
| Voice note, several things at once ("apple, pear, and one litre of water") | compound plumbing in routes + water/steps pass-through | ✅ fixed today, tested (was: half dropped) |
| Spoken amounts ("one litre", "two glasses") | `digitizeSpokenAmounts` | ✅ fixed today, tested |
| "Steps + water" / "steps + food" / all three in one message | stepReplyPart chaining | ✅ fixed today (steps+water was silently dropping water) |
| Logging **yesterday's** meals/steps ("izolo", "gister") | normalizer canonical + retro-date brakes + `stepIsRetro`/`parseMealDate` | ✅ live-proven (13/13 battery + screenshots) |
| isiZulu / isiXhosa / Sesotho / Afrikaans logging | normalizer multilingual examples | ✅ live-proven 13/13 |
| "Dinner same as my lunch" (incl. lunch not logged) | meal-copy + honest refusal | ✅ live-proven (screenshot) |
| "Can I eat X / is Y good for me" questions | engine front door + domain gate | ✅ live (engine-tagged replies) |
| Sick flow: report → held; "steps while sick?" → gentle; "week off, my muscles?" → comeback plan; "I'm back" | sick-flow + engine sick guard + comeback | ✅ live-proven (screenshots) |
| Frustration/pushback ("nope still shit", "you said…") | acknowledge-first law + drill cases | ✅ engine law 8; drill-locked |
| Meal photos, menus, step screenshots, form videos | media pipeline | ✅ built (0% silence paths) |
| "How am I doing / my progress" | engine, snapshot-grounded | ✅ live |
| Weight logging + trends + auto-adjustment | weight handler + `runAutoCalAdjust` (3-week engine) | ✅ live for months |

## 2. Open gaps — found by audit, prioritized, owned
**P0 (this week, builder):**
1. ~~Compound water/steps/food drops~~ — closed today (see §1).
2. **quality_signals → regression-case loop**: weak live exchanges now auto-file
   nightly; builder must convert each into a drill/battery case same-session.
   (Process now; automate the conversion later.)

**P1 (before closed beta):**
3. **Spelled-out numbers in African languages** ("izinyathelo eziyishumi" = ten
   thousand steps): the anti-hallucination number brake whitelists English
   number-words only, so these fail SAFE (not logged) instead of logging. Fix =
   extend the brake's word list per language; keep fail-closed default.
4. **Battery breadth**: Setswana + Xitsonga cases are thin (2 languages carry
   most coverage). Add ≥3 cases each; run live.
5. **Compound "question + log"** ("I had eggs — is that enough protein?"):
   verify the log fires AND the question gets answered; add battery cases.

**P2 (during beta, evidence-driven):**
6. Outcome dashboard fills with real cohort data (`/api/admin/outcomes` is live, empty).
7. Word-amount support beyond water containers if testers actually use it
   ("ate two eggs" already works via food scanner — monitor, don't pre-build).

## 3. The self-correcting machine (why screenshots are no longer the founder's job)
1. **Every client, every message**: perception pass updates that client's
   durable understanding (story, facts, trust, readiness — inferences decay).
2. **Every night 23:30**: the checker samples 20 real exchanges, grades them
   harshly, **auto-files** anything under 6/10, and WhatsApps the founder a
   one-line digest ("scored 20 — 8.1/10, 2 weak ones filed, no action needed").
3. **Every night 03:00**: the drill battery replays every tester failure ever
   recorded against the live model; leak-risks alert loudly, canary-only drift
   is labelled client-safe.
4. **Every session**: the builder drains the filed queue → root-cause fix →
   permanent regression case. The battery only grows.

*The founder's job is distribution and testing like a user. The system's job is
catching itself. The builder's job is everything in §2.*
