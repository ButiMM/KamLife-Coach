# The commitment loop (capability 3: help me follow through): SPEC ONLY (#508)

**Status:** a draft for founder sign-off. No code until it is signed. Coverage rows: A19, A14/B7, B1/B2, B6.

## 1. What the client gets

The client chooses one small thing, and Coach K helps them get ready for it. Coach K notices whether it happened and responds kindly either way. It follows up once, at a time the client can use, and the next plan learns from what happened. The loop runs **choose → prepare → notice → respond → follow up → learn**.

The loop must never:
- invent a commitment the client didn't make;
- chase twice;
- shame a miss;
- ask about something already done;
- send more than the one proactive message a day.

## 2. What it reuses (no new store)

| Need | Reused from |
|---|---|
| The commitment itself | The client record (`core/client-record.ts`). A new fact kind, `commitment`, has a due day and a state (`open`, `kept`, `missed`, `released`). It is written by `applyFacts` from the client's own words only. |
| Evidence it happened | The ledgers: `meal_logs`, `workout_logs`, `step_logs`, `weight_logs`, through the day ledger (`day-ledger.ts`), which is already the one reader. |
| The follow-up message | `reminders.ts` (the `return` kinds already retire themselves when the client has come back, via `hasReturnedSince`), sent through `sendProactive` (#501) with its pause, cap, claim and opt-out floors. |
| Today's training loop | `memory.ts` `ensureOpenTrainingLoop` is a narrow commitment loop for training (proposed → awaiting outcome). It becomes the first instance of this loop, not a second one beside it. |
| What to suggest | `canonicalNextMove` / `chooseAction`: the one decision owner. A commitment is the client's version of the one action. |

## 3. When Coach K proposes a commitment

- **Only when the client is present:** in a reply, never cold in a proactive message.
- **Only one open at a time.** If one is open, Coach K asks about that one instead.
- **After a "help me now" answer that has a natural next step.** For example: "want to lock in Thursday's session?" The client must say yes in their own words. A "yes" to a question counts. Silence doesn't.
- **Not when:**
  - they're sick or paused (health state);
  - they're in crisis or a safety floor fired;
  - they asked us not to mention the domain (`do_not_mention`);
  - they closed the day (held constraints).

## 4. What counts as evidence

| Commitment | Kept when |
|---|---|
| Train on a day | A `workout_logs` row on that SAST day, or the client says so (logged through A8) |
| Log food for N days | N distinct SAST days in `meal_logs` within the window |
| Walk / steps | `step_logs` at or above the target they named, on that day |
| Weigh in | A `weight_logs` row in the window |
| No takeaways / a food rule | Only what the client says. The ledger can't prove an absence, so Coach K asks once and believes the answer. |

A commitment with no evidence path isn't proposed as a checkable one. Coach K can still encourage it, without a follow-up.

## 5. Follow-up timing (WhatsApp rules)

- **Inside the 24-hour window:** free-form, once, at the client's usual active hour on the due day (from their last inbound times). If they write to us first that day, the follow-up is folded into our reply and no proactive message is sent.
- **Outside the window:** only an approved template. Its Meta category (utility or marketing) is unknown until Meta approves it, and the category sets the cost (`docs/COSTS.md`). Until one is approved, there is **no follow-up outside 24 hours**. The commitment waits for the client's next message.
- **At most one follow-up per commitment,** inside the one-a-day proactive cap. It replaces that day's morning or evening touch; it never adds to it.
- **Released automatically** after the due day plus 2 days with no evidence and no reply: the state becomes `released`, with no message.

## 6. How a miss changes the plan

- The reply to a miss is short, with no shame, and asks one question: what got in the way? The answer is recorded as a `constraint` or `schedule` fact.
- The next proposal is **smaller**: fewer days, a shorter session, an easier time. Two misses in a row on the same kind of commitment mean Coach K stops proposing that kind for 7 days and offers a different domain.
- A kept commitment earns a slightly bigger next one, never more than one step up.
- Nothing is taken away. Targets change only through the existing target owners (`adaptive-targets.ts`, `targets.ts`).

## 7. What's measured (in the #506 evidence view)

- Commitments proposed, accepted, kept, missed and released, per client per week.
- Share of follow-ups sent inside the 24-hour window versus skipped (no template).
- Opt-outs or "stop" within 24 hours of a follow-up. This is the harm signal: any rise pauses the loop.
- Retention at 14 and 30 days (D12), clients with the loop versus without, once there are enough clients to compare.

## 8. Gate cases (journeys, added to `docs/TESTER-EXPERIENCE.md` when the spec is signed)

1. **accept-thursday-session**: "yes, Thursday after work" leads to one open commitment due Thursday, and nothing else is asked.
2. **silence-is-not-yes**: Coach K suggests a session and the client changes the subject. No commitment is written.
3. **kept-no-chase**: a workout is logged Thursday morning, so there's no follow-up. The next reply recognises it in one line.
4. **missed-kindly**: no evidence by Thursday's end. On Friday, one message asks what got in the way, with no guilt words, and the next proposal is smaller.
5. **two-misses-change-domain**: two missed training commitments in a row. Coach K doesn't propose training for 7 days and offers a food or steps commitment.
6. **outside-window-waits**: the client has been silent 30 hours on the due day and there's no approved template. Nothing is sent. The next inbound gets the follow-up folded into the reply.
7. **sick-releases**: the client says they have flu. The open commitment is released, with no follow-up, and the reply is about rest.
8. **no-takeaways-believed**: "no takeaways this week" is followed up once on Sunday, and "I had KFC once" is recorded without judgement. The ledger isn't used to accuse.

## 9. Open decisions for the founder

1. Which commitment kinds ship first? Proposed: training days and food-logging days only (the ones with ledger evidence).
2. Should we submit a follow-up template to Meta now (utility category requested), knowing it may be classed as marketing?
3. Should a follow-up replace the morning message on its day (proposed), or the evening one?
