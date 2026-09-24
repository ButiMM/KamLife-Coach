/**
 * THE POSTGRESQL ACCEPTANCE RUNNER — one owner for reset, execution, collection and exit code (#227).
 *
 * WHAT THIS REPLACES, AND WHY. The authoritative `pg-acceptance` job was eighteen sequential
 * GitHub Actions steps sharing one ephemeral database. That arrangement caused two proven
 * engineering-control failures, both of which cost real diagnosis time:
 *
 *   CROSS-ACCEPTANCE CONTAMINATION. The suites are not isolated from each other — Coach Health
 *   reads `turn_ledger` database-wide, for one — so rows written by an earlier acceptance change
 *   what a later one sees. On #224 three "product regressions" were reported from a batch run and
 *   evaporated when each acceptance was rerun after its own reset. A false diagnosis reached a
 *   lane decision before it was caught.
 *
 *   EARLY-EXIT BLINDNESS. A step that fails ends the job, so every later step is skipped. While
 *   one product acceptance was red, seven others never executed — including the proof a branch had
 *   just added. A branch could hold excellent local evidence that authoritative CI had never once
 *   run. That is the worst failure mode available to a gate: not a wrong answer, but no answer
 *   wearing the same colour as one.
 *
 * THE RULE THIS ENFORCES: every acceptance runs, every acceptance starts from the same clean
 * database, every verdict is recorded, and the job is still RED if any of them failed.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE. No `continue-on-error` — that turns a real red into a
 * warning wearing a different colour, which the workflow already rejected in writing for the
 * Journey Lab. No second PostgreSQL service to sidestep ordering. No reordering. The order below
 * is the order the workflow had.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface Acceptance {
  /** Short id for the summary table. */
  id: string;
  /** Human sentence for the log header — what this proof is about. */
  title: string;
  /** Argv to execute. Kept as argv rather than a shell string so nothing is word-split. */
  command: string[];
}

/**
 * THE INVENTORY, AND THE ONLY COPY OF IT (#227).
 *
 * This list lived in the workflow YAML, where each entry carried the reason real PostgreSQL was
 * required rather than a fixture. Those reasons are the valuable part and they move here with the
 * list; the workflow now calls this runner once. Two owners of the same inventory is how a new
 * acceptance gets added in one place and silently never runs in the other.
 */
export const ACCEPTANCES: Acceptance[] = [
  { id: "correction", title: "Targeted multi-day food correction",
    // The deterministic stub ignores ORDER BY and does not reflect UPDATEs into reads, so it
    // cannot say WHICH row a named-day correction lands on.
    command: ["npx", "tsx", "script/pg-correction-acceptance.ts"] },

  { id: "safety-turn", title: "Safety early-return turn attribution",
    command: ["npx", "tsx", "script/pg-safety-turn-acceptance.ts"] },

  { id: "step-provenance", title: "Step provenance bridge",
    // THE PROVENANCE OWNER IS A DATABASE FUNCTION (#184), so PostgreSQL is the only thing that can
    // say whether its regular expressions compile. The broken version threw inside an AFTER INSERT
    // trigger the application never awaits — a green suite, a normal reply, and every
    // client-stated step count silently left untrusted.
    command: ["npx", "tsx", "script/pg-step-provenance-acceptance.ts"] },

  { id: "spoken-step-reverts", title: "Spoken compound counts fail on both owner reverts",
    // VOICE INPUT TRUTH (2026-09-10). A correct transcript saying "eight thousand five hundred"
    // passes two owners before it is durable: TypeScript extracts the value and PostgreSQL marks
    // the row trusted. This restores each pre-cut owner independently and requires the relevant
    // customer/DB acceptance to turn red; a crash or absent verdict is itself red.
    command: ["bash", "script/red-on-revert-spoken-steps.sh"] },

  { id: "client-truth", title: "Canonical client truth ordering",
    command: ["npx", "tsx", "script/pg-client-truth-acceptance.ts"] },

  { id: "fallback-truth", title: "Fallback reads canonical truth",
    // TWO READERS, ONE SET OF FACTS (#179). Provenance, resolved_day and the workout ledger are
    // COLUMNS, so only a real database can show that the canonical snapshot and the GPT fallback's
    // context are reading the same rows — a fixture that answers every query the same way cannot
    // tell two readers apart, which is how the divergence survived.
    command: ["npx", "tsx", "script/pg-fallback-truth-acceptance.ts"] },

  { id: "proactive-authority", title: "Proactive decision authority",
    // ONE COACH, PROACTIVELY AND REACTIVELY (#180). Held constraints are rows the client wrote
    // today; whether the proactive decision reads them is only answerable against a database.
    command: ["npx", "tsx", "script/pg-proactive-authority-acceptance.ts"] },

  { id: "daily-constraint", title: "Daily constraint lifecycle",
    // A DAILY CONSTRAINT IS ABOUT WHAT SURVIVES (#194). The defect was a 24-message window, and a
    // fixture that returns the same rows to every query cannot demonstrate a window.
    command: ["npx", "tsx", "script/pg-daily-constraint-acceptance.ts"] },

  { id: "food-constraint-mouths", title: "Food constraints reach the plate and grocery mouths",
    // THE CONSTRAINT REACHES EVERY MOUTH THAT NAMES A FOOD (#128). Which branch of the Next Meal
    // menu a client reaches is composed from the day ledger — what is logged, what is left — so a
    // fixture that answers every query the same way puts every client on one branch.
    command: ["npx", "tsx", "script/pg-food-constraint-mouths-acceptance.ts"] },

  { id: "weight-authority", title: "One weight-direction authority",
    // ONE ANSWER TO "WHICH WAY IS THE SCALE GOING" (#128). The verdict is computed from weigh-in
    // ROWS — how many, how far apart, how recent — against an illness window in profile_notes, and
    // the proactive half is graded on the message it actually sends, captured through the shadow
    // door. Neither is expressible on a fixture that answers every query the same way.
    command: ["npx", "tsx", "script/pg-weight-authority-acceptance.ts"] },

  { id: "open-coaching-loop", title: "Open training move survives and resolves across turns",
    // ONE OPEN COACHING LOOP (#208). Restart durability, user isolation and exact SAST attribution
    // require the real database; a fixture cannot prove compare-and-set closure.
    command: ["npx", "tsx", "script/pg-open-coaching-loop-acceptance.ts"] },

  { id: "thin-evidence", title: "Thin-evidence coaching",
    // A SPARSE CLIENT IS COACHED, NOT JUST RECEIPTED (#203). Every decision here is computed from
    // rows — how many days carry a meal, whether one carries TODAY, how stale the weigh-in is, and
    // whether a same-day re-weigh updates or inserts.
    command: ["npx", "tsx", "script/pg-thin-evidence-acceptance.ts"] },

  { id: "information-value", title: "Highest-value investigation",
    // INFORMATION VALUE (#213). Weekend coverage, stalled trend, the durable open loop and the
    // later backdated answer are all real rows; this grades the one canonical INVESTIGATE owner.
    command: ["npx", "tsx", "script/pg-information-value-acceptance.ts"] },

  { id: "information-value-clock", title: "The information-value acceptance is deterministic on every day",
    // It was green every weekday and red every weekend, and it blocked PR #244 — a cut that
    // touches none of this code — on a Saturday. Case 1 reproduces those four failures on demand
    // by pinning the file to that Saturday, so the defect is provable on a Tuesday.
    command: ["bash", "script/red-on-revert-information-value-clock.sh"] },

  { id: "behaviour-patterns", title: "Evidence-backed behavioural patterns",
    // BEHAVIOURAL PATTERN STATE (#217). Repetition, attributed outcomes, user isolation and
    // contradiction are properties of longitudinal rows. The profile must then be read by the
    // same canonical decision through both doors; a fixture cannot establish either claim.
    command: ["npx", "tsx", "script/pg-behaviour-pattern-acceptance.ts"] },

  { id: "log-turn", title: "Durable log turns are one coaching turn",
    // ONE COACH SPEAKING (#207). The repetition defect this closes is invisible to a fixture that
    // sends one message per client: it only appears across CONSECUTIVE durable writes by the same
    // person, where the decision is recomputed from day state the new event did not move.
    command: ["npx", "tsx", "script/pg-log-turn-acceptance.ts"] },

  { id: "facts", title: "Facts, retractions and same-turn propagation",
    // FACTS, RETRACTIONS AND SAME-TURN PROPAGATION (#211). Retraction-before-append ordering, one
    // operation building on another's patch, and unrelated columns left alone are all properties
    // of a real transaction — which is how a retracted diet came back inside its own write.
    command: ["npx", "tsx", "script/pg-facts-acceptance.ts"] },

  { id: "food-identity", title: "Food identity and stated portion",
    // FOOD IDENTITY AND STATED PORTION (#206). Identity and portion are what get WRITTEN, and the
    // invented-combo defects were visible only as kcal in the ledger.
    command: ["npx", "tsx", "script/pg-food-identity-acceptance.ts"] },

  { id: "weight-speakability", title: "Weight authority and speakability",
    // ONE WEIGHT AUTHORITY, ONE SPEAKABILITY VERDICT (#216). Illness contamination, window width
    // and chronology are all properties of stored rows against stored dates, and the Monday claims
    // only exist as a sent message — SHADOW=on captures them.
    command: ["npx", "tsx", "script/pg-weight-speakability-acceptance.ts"] },

  { id: "restriction-consistency", title: "One restriction across every food surface",
    // ONE RESTRICTION, EVERY SURFACE (#220). Consistency is a claim about what a CLIENT receives
    // across surfaces reached by different handlers, different scheduler jobs and different cron
    // minutes — a unit test on `allows` proves the predicate and nothing about who asked it.
    command: ["npx", "tsx", "script/pg-restriction-consistency-acceptance.ts"] },

  { id: "comeback-clock", title: "One comeback clock",
    // ONE COMEBACK CLOCK (#221). Both defects are claims about CHRONOLOGY across stored rows — a
    // workout row's logged_at against a user's lastActiveAt, read through the real handler.
    command: ["npx", "tsx", "script/pg-comeback-clock-acceptance.ts"] },

  { id: "session-recap", title: "One training recap that does not contradict itself",
    // ONE RECAP (#221 journey 4). The contradiction only exists across two row families — workout
    // rows present, meal rows absent — composed into one card by one owner. A fixture that answers
    // every query the same way cannot put a client in the state where the card disagrees with
    // itself, which is how "Sessions this week: 4" sat above "Days logged (7d): 0/7".
    command: ["npx", "tsx", "script/pg-session-recap-acceptance.ts"] },

  { id: "session-owner", title: "One progression owner, despite a legacy lifetime mismatch",
    // ONE PROGRESSION OWNER (#221 journeys 5-7). The whole proof is a legacy client whose lifetime
    // counter disagrees with the durable ledger — seven rows against twelve — read through five
    // different handlers that must still agree about where the client is in the programme. A
    // fixture that answers every query the same way cannot produce that disagreement, and the
    // cursor discipline on a backfill is a claim about what a write did NOT touch.
    command: ["npx", "tsx", "script/pg-session-owner-acceptance.ts"] },

  { id: "messy-reentry", title: "Messy multi-day catch-up and re-entry",
    // MULTI-DAY RE-ENTRY (#229). Date placement, explicit unknowns, exact correction isolation
    // and closure of an older open-loop ref are persisted chronology claims, not fixture claims.
    command: ["npx", "tsx", "script/pg-messy-reentry-acceptance.ts"] },

  { id: "messy-reentry-reverts", title: "Messy re-entry controls fail on every mechanism revert",
    command: ["npx", "tsx", "script/pg-messy-reentry-red-on-revert.ts"] },

  { id: "missed-session-outbound", title: "The missed-session answer survives the outbound floor",
    // #233. The handler's return was correct the whole time; the truth floor threw it away and the
    // client got the generic repair. Only a real database and the real transport path can show
    // that — the record the floor checks against IS the ledger, and the substitution happens in
    // sendFinal, past every handler.
    command: ["npx", "tsx", "script/pg-missed-session-outbound-acceptance.ts"] },

  { id: "interaction-truth", title: "The ledger records what the client received, and a repeat is answered",
    // Cut 1. Two defects proven post-transport on 7833ebb and invisible to every handler-level
    // suite: the same question asked twice got the outbound repair ("ask me again") while BOTH
    // ledger rows showed the correct reply, and the ledger held `[BUTTONS:…]` for a client who saw
    // `▸ *Today's workout*`. Only the real transport can grade either — the substitutions happen
    // in prepareOutbound and sendFinal, past every handler.
    command: ["npx", "tsx", "script/pg-interaction-truth-acceptance.ts"] },

  { id: "journal-guard", title: "The migration journal cannot silently skip a migration",
    // A SUCCESSFUL COMMAND THAT SKIPPED A MIGRATION (2026-09-11). `db:migrate` reported success and
    // did not run 0013, because drizzle orders by the journal's `when` and 0013 was stamped behind
    // 0012. No database is needed — the guard reads files — but it lives in this runner because
    // this is the inventory that is actually authoritative, and a guard nobody runs is a comment.
    command: ["bash", "script/red-on-revert-journal-guard.sh"] },

  { id: "voice-provenance", title: "The words the client actually spoke are durable",
    // RAW VOICE PROVENANCE (2026-09-10). A voice note becomes three strings — STT output, cleaned,
    // condensed — and only the last reached the ledger, so "did we mis-hear them, or hear them and
    // then delete half of it?" had no durable evidence. Needs a real database: the claim is about
    // which COLUMNS on which ROW survive the transport, and a fixture that answers every query the
    // same way cannot tell two ledger rows apart.
    command: ["npx", "tsx", "script/pg-voice-provenance-acceptance.ts"] },

  { id: "voice-provenance-reverts", title: "Voice provenance fails on every stage revert",
    // Each media.ts recording seam and the ledger writer are reverted independently; the relevant
    // suite must turn red. A crash or an absent verdict is itself red.
    command: ["bash", "script/red-on-revert-voice-provenance.sh"] },

  { id: "meal-slot-truth", title: "The clock may not name a meal the client did not name",
    // CUT 2 (2026-09-11). At 06:00/13:00/22:00 SAST a client who names no meal must get no meal
    // name written to their record. Needs a real database and the real front door: every claim is
    // about which STRING landed in meal_logs.meal_label and what the post-transport body said
    // about it, and the repeat case needs two turns of one client's real day to exist at all.
    command: ["npx", "tsx", "script/pg-meal-slot-truth-acceptance.ts"] },

  { id: "meal-slot-reverts", title: "Every removed meal-slot invention turns the acceptance red",
    // The send clock, the calorie rule, a typed time, the photo path's own clock, the repeat
    // target and the duplicate-guard sentence are each restored independently, plus two
    // opposite-defect controls. A crash or an absent verdict is itself red.
    command: ["bash", "script/red-on-revert-cut2-meal-slot.sh"] },

  { id: "long-voice-tail", title: "A long note reaches the handlers whole",
    // CUT 3 (2026-09-12). The cleaner sent 1,500 characters to a model and returned the answer as
    // THE TRANSCRIPT, deleting 908 characters of a three-minute note — both questions among them.
    // Needs a real database and the real front door: the claim is about what the handlers were
    // GIVEN, durably, and about the numbers that reached their owners afterwards.
    command: ["npx", "tsx", "script/pg-long-voice-tail-acceptance.ts"] },

  { id: "long-voice-reverts", title: "Every silent cut in the voice pipeline turns a grader red",
    // Four truncations in one pipeline — the cleaner's window, its missing lower bound, the
    // condenser, and the ledger's own cap — plus three opposite-defect controls. Two graders,
    // because the acceptance drives the TEXT door where the cleaner never runs.
    command: ["bash", "script/red-on-revert-cut3-long-voice.sh"] },

  { id: "long-turn-reverts", title: "Every Cut 5 long-turn seam turns the behavioral acceptance red",
    // Food routing, correction replacement, single-question early ownership and the complete
    // Coach context are reverted independently against the same post-sendFinal journey.
    command: ["bash", "script/red-on-revert-cut5-long-turn.sh"] },

  { id: "final-response-owner", title: "A client's question is answered by the one final response owner",
    // #92 (2026-09-15). On a decision turn the Coach mouth was gated on isMultiPartAsk, so a SHORT
    // question was never asked at all and three unrelated turns shipped the same canonical action
    // line byte for byte. Needs a real database and the real front door: every claim is about the
    // post-sendFinal body, what the mouth was handed, and which turns must NOT change.
    command: ["npx", "tsx", "script/pg-final-response-owner-acceptance.ts"] },

  { id: "final-response-reverts", title: "Every #92 response-owner seam turns the acceptance red",
    // The gate, the composed answer, the canonical action, what the mouth is handed and what it is
    // told — reverted independently — plus two opposite-defect controls: a gate opened to every
    // decision turn, and a turn whose deterministic owner stands down.
    command: ["bash", "script/red-on-revert-92-final-response-owner.sh"] },

  { id: "meal-date-slot", title: "The eating clause owns the meal's date and slot, not the dinner question",
    // C9 (2026-09-15). "I had a pear. What should I have for dinner tonight?" stored the pear on
    // YESTERDAY labelled "dinner" — both words were taken from the question — and the reply then
    // asked the client to log food it had just written. Needs a real database and the real front
    // door: the claims are the stored row's SAST day and label, and the post-transport body.
    command: ["npx", "tsx", "script/pg-meal-date-slot-acceptance.ts"] },

  { id: "meal-date-slot-reverts", title: "Every C9 date and slot seam turns the acceptance red",
    // The date word, the clause scoping, the eating vocabulary and the floors it composes —
    // reverted independently — plus the opposite-defect control: a fallback removed so that a
    // caption's plainly named meal goes missing instead of being wrongly invented.
    command: ["bash", "script/red-on-revert-c9-meal-date-slot.sh"] },

  { id: "food-calorie-truth", title: "One food evidence, one nutritional truth",
    // C11 (2026-09-16). The governing rule is that meal calories EQUAL the sum of their persisted
    // item calories, and the ledger held it throughout — the mismatch was upstream. A correction
    // degraded into an append (580 -> 877), the quantity axis did not exist, provenance was
    // dropped at persistence, and the photo total was a second ledger beside its own items.
    command: ["npx", "tsx", "script/pg-food-calorie-truth-acceptance.ts"] },

  { id: "food-calorie-truth-reverts", title: "Every C11 food-truth seam turns the acceptance red",
    // Eight isolated mutations: both correction-owner escapes, the portion-authority bypass, the
    // unresolvable-removal append, provenance dropped at persistence, the discarded repeat slot,
    // a zero-calorie day read as unlogged, and the photo total defeating its own item sums.
    command: ["bash", "script/red-on-revert-c11-food-calorie-truth.sh"] },

  { id: "question-owns-turn", title: "A fact survives the question riding with it, and the question is answered",
    // C12 (2026-09-17). "I had a pear. What should I do today?" wrote NOTHING and asked for the
    // pear back; "I had chicken and rice for lunch. What should I do today?" priced the question's
    // own words as food and never answered it. Both halves worked alone — the bubble broke both.
    command: ["npx", "tsx", "script/pg-question-owns-turn-acceptance.ts"] },

  { id: "question-owns-turn-reverts", title: "Every C12 question-owns-turn seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-c12-question-owns-turn.sh"] },

  { id: "voice-safety-parity", title: "Pain reaches the safety owner, and its answer reaches the client",
    // C13 (2026-09-17). "my knee is clicking and sore after the squats, should I take
    // anti-inflammatories?" was answered by the SUPPLEMENT handler — "keep it consistent" — with
    // the knee never mentioned; a clicking knee reached no safety owner at all; and once routing
    // was fixed the DOMS answer was blocked by the truth floor reading "day 2" as two sessions.
    command: ["npx", "tsx", "script/pg-voice-safety-parity-acceptance.ts"] },

  { id: "voice-safety-parity-reverts", title: "Every C13 safety-parity seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-c13-voice-safety-parity.sh"] },

  { id: "honest-gap", title: "A quiet week is a quiet week, and the ask is honest or absent",
    // C14 (2026-09-18). A client who joined FIVE DAYS AGO, never logged, typing at the keyboard,
    // was told "It's been about 14 weeks … Your numbers are exactly where you left them" —
    // `dayStateFrom` mapped "no meal row on file" to the sentinel 99 and rung 1 divided it by
    // seven. And every late empty day closed on "I can't coach a day I can't see.", a complaint
    // under a request that already said everything the request needed to say.
    command: ["npx", "tsx", "script/pg-honest-gap-acceptance.ts"] },

  { id: "honest-gap-reverts", title: "Every C14 honest-gap seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-c14-honest-gap.sh"] },

  { id: "present-client", title: "The present client is coached, and one question has one answer",
    // C15 (2026-09-18). Four quiet days, at the keyboard: "what should I do today?" answered
    // "Log one meal today", "I'm lost" answered "Tell me what you ate today", and "I'm struggling"
    // answered with sympathy and no move at all — while 0 of 3 sessions sat in workout_logs. Two
    // callers of one question disagreed about atKeyboard and neither set asksAboutToday; `train`
    // was graded on the food ledger, which four quiet days makes insufficient by arithmetic; and
    // the canonical close returned early on any turn that wrote no durable fact.
    command: ["npx", "tsx", "script/pg-present-client-acceptance.ts"] },

  { id: "present-client-reverts", title: "Every C15 present-client seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-c15-present-client.sh"] },

  { id: "c16-plate", title: "A named dinner ask gets a cookable plate, while pear truth and maintenance survive",
    // C16 (2026-09-21). The existing next-meal menu rejected any utterance naming dinner, so
    // a log-plus-dinner question bypassed the ledger-aware plate owner. Grade product-menu words
    // in the delivered body, not the model stub, with ENGINE_LIVE on.
    command: ["npx", "tsx", "script/pg-c16-plate-acceptance.ts"] },

  { id: "followup-arrives", title: "The coach does not chase a commitment the client already kept",
    // C17 (2026-09-21). A client said they were away until Friday, came back Wednesday and logged
    // a meal. Thursday 19:00 the booked nudge fired anyway: "Tomorrow you're back! … nothing
    // reset, your plan's exactly where you left it." cancelReturnNudges has ONE call site, behind
    // a health hold in sick-flow.ts, so a holiday nudge can never take that exit and a client who
    // simply resumes logging declares nothing. The firing job now asks the durable ledgers.
    command: ["npx", "tsx", "script/pg-followup-arrives-acceptance.ts"] },

  { id: "followup-arrives-reverts", title: "Every C17 follow-up seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-c17-followup-arrives.sh"] },

  { id: "turn-reply-integrity", title: "The reply reconcileTurnReply repaired is the reply that ships",
    // C10 (2026-09-15). reconcileTurnReply computed its write-integrity repair and directive strip
    // into `draft`, then returned `reply` — the original, unverified model string — from every
    // ordinary exit, so a client was told "Noted 👌" about a record that does not exist. Needs a
    // real database and the real front door: the claims are the function's RETURN VALUE, the
    // post-transport body, and the stored rows that make the confirmation false.
    command: ["npx", "tsx", "script/pg-turn-reply-integrity-acceptance.ts"] },

  { id: "turn-reply-integrity-reverts", title: "Every C10 reply-integrity seam turns the acceptance red",
    // The ordinary exit, the held repair, the second mouth and the flag it reads — reverted
    // independently — plus the other owner on the same journey: an under-eating warning that
    // swallowed the client's question entirely.
    command: ["bash", "script/red-on-revert-c10-turn-reply-integrity.sh"] },

  { id: "age-gate", title: "Under-18s cannot complete signup or keep being coached",
    // #267. Needs the real front door (the onboarding state machine and the mid-conversation
    // gate in routes.ts), users.onboarding_state and the post-transport body.
    command: ["npx", "tsx", "script/pg-age-gate-acceptance.ts"] },

  { id: "age-gate-reverts", title: "Every #267 age-gate seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-age-gate.sh"] },

  { id: "stt-admission", title: "A garbled transcript writes nothing, a real one writes everything",
    // CUT 4 (2026-09-12). The garble floor read `if (voiceQuality && …)` and voiceQuality is set
    // only by Whisper attempt 1 — so Scribe (which runs FIRST in production), the catch retry and
    // the forced-English retry all SKIPPED it. Needs a real database because the claim is about
    // what a refused transcript does NOT store, and what an admitted one does.
    command: ["npx", "tsx", "script/pg-stt-admission-acceptance.ts"] },

  { id: "stt-admission-reverts", title: "Every bypass of the admission floor turns a grader red",
    // One mechanism per case: the metrics-only condition returning, each content check removed,
    // and two opposite-defect controls so a floor that refuses everything cannot pass.
    command: ["bash", "script/red-on-revert-cut4-stt-admission.sh"] },

  { id: "popia-deletion", title: "\"Delete my data\" deletes the client, everywhere",
    // #269. Needs the real front door, the real foreign-key cascades and every table in the
    // catalogue that holds a user_id or a phone.
    command: ["npx", "tsx", "script/pg-popia-deletion-acceptance.ts"] },

  { id: "popia-deletion-reverts", title: "Every #269 deletion seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-popia-deletion.sh"] },

  { id: "proactive-template", title: "A generic check-in leaves no trace of a message it did not carry",
    // CUT 6 (2026-09-14). The window-recovery template returned "fallback", which deliveryAccepted
    // reads as true — so the morning job opened a training loop for a client who had seen only
    // "Coach K checking in". Whether a follow-up row EXISTS afterwards is a database question.
    command: ["npx", "tsx", "script/pg-proactive-template-acceptance.ts"] },

  { id: "proactive-template-reverts", title: "Every way a quiet client stops hearing from the coach turns a grader red",
    // CUT 6 (2026-09-14). Three approved templates had no call site, so every closed-window send
    // degraded to a generic check-in AND was recorded as a delivery. One mechanism per case, plus
    // two opposite-defect controls.
    command: ["bash", "script/red-on-revert-cut6-proactive-templates.sh"] },

  { id: "calorie-floor", title: "One calorie floor, and no writer below it",
    // #268. The weigh-in auto-adjust needs real weight_logs across a fortnight and the front door;
    // the diet-break restore needs the real job against a seeded client.
    command: ["npx", "tsx", "script/pg-calorie-floor-acceptance.ts"] },

  { id: "calorie-floor-reverts", title: "Every #268 floor seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-calorie-floor.sh"] },

  { id: "evening-delivery", title: "The empty day reaches the client, or the record says it did not",
    // C17 EVENING. evening.ts sends the one message written FOR a silent client — which is exactly
    // the client whose 24-hour window is shut — so it degrades to the generic check-in. No approved
    // template content-matches it, so the substitution stands; what could not stand was filing it
    // as an ordinary delivery. Durable question: what does chat_history say the coach said?
    command: ["npx", "tsx", "script/pg-evening-delivery-acceptance.ts"] },

  { id: "evening-delivery-reverts", title: "Every C17 evening seam turns the acceptance red",
    // C17 EVENING. One mechanism per case, plus the control that refuses the cheapest way to pass
    // every "it did not arrive" assertion: sending nothing at all.
    command: ["bash", "script/red-on-revert-c17-evening-delivery.sh"] },

  { id: "visible-nags", title: "Present clients are not told to log; no invented gaps, daily weigh-ins or trial",
    // #275. Presence is read from chat_history rows the database stamps, the weigh-in cap from
    // sent_proactive, and "Just finished dinner" must reach meal_logs through the front door.
    command: ["npx", "tsx", "script/pg-visible-nags-acceptance.ts"] },

  { id: "visible-nags-reverts", title: "Every #275 nag/gap/weigh-in seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-visible-nags.sh"] },

  { id: "payments-cancel-truth", title: "Cancelling stops the money, and the money tells the truth",
    // Audit P0 (2026-09-22). "yes, cancel" promised "you will not be charged again" and nothing
    // reached PayFast; the next charge reactivated the client and nulled cancelled_at; a canceller
    // was lined up for "your payment didn't go through"; and a real PayFast ITN — signed in the
    // order PayFast sends it — was refused because the webhook re-sorted the fields. Needs the
    // real ITN route over HTTP, payment_events, admin_events and the post-transport bodies.
    command: ["npx", "tsx", "script/pg-payments-cancel-truth-acceptance.ts"] },

  { id: "payments-cancel-truth-reverts", title: "Every payments seam turns the acceptance red",
    // Twelve isolated mutations, including the opposite-defect case: a charge-after-cancel guard
    // that stops checking WHICH subscription was charged locks out a client coming back on a new one.
    command: ["bash", "script/red-on-revert-payments-cancel-truth.sh"] },

  { id: "opt-out", title: "An opt-out is honoured on every send path",
    // #265 (AUDIT.md P0). Only the exact word STOP opted out, and only jobs that remembered to read
    // the pause honoured it — payment recovery, critical alerts, the dashboard broadcast and the
    // payment webhook did not. Needs the front door, the scheduler door, the dashboard/admin and
    // PayFast routes over HTTP, and the delivery owner's test seam.
    command: ["npx", "tsx", "script/pg-opt-out-acceptance.ts"] },

  { id: "opt-out-reverts", title: "Every #265 opt-out seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-opt-out.sh"] },

  { id: "safety-routing", title: "Pregnancy and disordered eating are routed before any reply",
    // #266 (AUDIT.md Traces 3, 6). A pregnancy question got her fat-loss target; a purging
    // disclosure was asked "what was it, roughly?". Needs the front door AND the proactive door,
    // users.life_situation, escalations and the post-transport bodies.
    command: ["npx", "tsx", "script/pg-safety-routing-acceptance.ts"] },

  { id: "safety-routing-reverts", title: "Every #266 safety-routing seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-safety-routing.sh"] },

  { id: "meal-decline", title: "Declining a suggestion deletes nothing; a correction supersedes",
    // #264 (AUDIT.md Trace 1). "No I'm just fine with this meal" was a CORRECTION — a leading "No"
    // plus the word "meal" — and the lunch logged a minute earlier was deleted, unrecorded. Needs
    // the real front door, meal_logs, turn_ledger.mutations and the post-transport body.
    command: ["npx", "tsx", "script/pg-meal-decline-acceptance.ts"] },

  { id: "meal-decline-reverts", title: "Every #264 decline/supersede seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-meal-decline.sh"] },

  { id: "scope", title: "The coach stays a coach: scope is enforced in code and fails closed",
    // #321 (Grok §8, audit C2). "Write my CV", crypto and antibiotic asks were answered, and a
    // classifier error failed OPEN. Needs the real front door and the post-transport bodies.
    command: ["npx", "tsx", "script/pg-scope-acceptance.ts"] },

  { id: "scope-reverts", title: "Every #321 scope seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-scope.sh"] },

  { id: "refund-guarantee", title: "The 14-day money-back guarantee, end to end (#328)",
    // Eligibility from the payment record, billing cancelled, the refund owed recorded with a due
    // date, the founder told exactly what to refund, the client told the truth; repeat and
    // out-of-window asks; a cancelled client within 14 days gets the guarantee, not a pay link.
    command: ["npx", "tsx", "script/pg-refund-guarantee-acceptance.ts"] },

  { id: "spend-cap", title: "The AI spend cap fails safe (#340)",
    // A daily account-wide ceiling that stops model calls, an unreadable spend query that means
    // "over", and the meaning engine under the same cap. Needs gpt_costs, admin_events, the bodies.
    command: ["npx", "tsx", "script/pg-spend-cap-acceptance.ts"] },

  { id: "spend-cap-reverts", title: "Every #340 spend-cap seam turns the acceptance red",
    command: ["bash", "script/red-on-revert-spend-cap.sh"] },

  { id: "journey-lab", title: "Six critical journeys through the real system",
    // THE SIX JOURNEYS (#170). Same database, same migrations, same front door — a second job
    // would be a second copy of this infrastructure for no gain. It is in this runner for the same
    // reason it was never `continue-on-error`: a known-wrong durable state must not be reported as
    // a warning, and this runner keeps its red a red.
    command: ["npm", "run", "test:journeys"] },
];

// ── THE RESET, AND WHAT IT REFUSES TO DO ──────────────────────────────────────────────────────

/** Hosts a throwaway test database can legitimately live on. Anything else is somebody's data. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "postgres"]);

/**
 * FAIL CLOSED, AND SAY WHY (#227).
 *
 * This function's whole job is to stand between "truncate every table" and a database that is not
 * a disposable test one. It answers with a REASON rather than a boolean because the reason is what
 * a person reads at 2am when the runner refuses, and because a control can assert on it.
 *
 * The decisive check is the host: a production database for this product lives behind a remote
 * hostname, so refusing every non-loopback host puts it out of reach by construction rather than
 * by a name pattern someone could match by accident. The explicit opt-in is the second lock — a
 * developer who runs this file by hand on a laptop must say so, so that no script, hook or editor
 * task can wipe their working database as a side effect of doing something else.
 */
export function testDatabaseSafety(
  url: string | undefined,
  env: { CI?: string; PG_ACCEPTANCE_ALLOW_RESET?: string; NODE_ENV?: string } = {},
): { safe: true } | { safe: false; reason: string } {
  if (!url) return { safe: false, reason: "DATABASE_URL is not set" };

  let parsed: URL;
  try { parsed = new URL(url); } catch { return { safe: false, reason: "DATABASE_URL is not a URL" }; }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    return { safe: false, reason: `not a PostgreSQL URL (protocol ${parsed.protocol})` };
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    return { safe: false, reason: `host ${parsed.hostname} is not a local throwaway database` };
  }
  if (env.NODE_ENV === "production") {
    return { safe: false, reason: "NODE_ENV=production" };
  }
  // The opt-in is last so the message a developer sees first is about the DATABASE, not the flag.
  if (env.CI !== "true" && env.PG_ACCEPTANCE_ALLOW_RESET !== "1") {
    return { safe: false, reason: "not CI, and PG_ACCEPTANCE_ALLOW_RESET=1 was not given" };
  }
  return { safe: true };
}

/**
 * A CLEAN DATABASE MEANS THE SCHEMA TOO, NOT ONLY THE ROWS (#227, review).
 *
 * The first version of this truncated every table, which is not the promise this runner makes.
 * Acceptances mutate SCHEMA as well as data: `pg-step-provenance-acceptance` deliberately installs
 * the pre-#184 faulty `kamlife_parse_step_report`, proves it reproduces the original error, and
 * puts the working one back three statements later. If anything throws in that window the broken
 * function stays installed — and TRUNCATE does not remove a function. Every later acceptance,
 * Journey Lab included, would then run against a database whose step parser is the known-broken
 * one, and report cascading failures that belong to nothing in the diff. That is the exact
 * contamination this cut exists to end, arriving through a door truncation cannot close.
 *
 * So the reset rebuilds: drop the schema, drop the migration ledger with it, re-apply the
 * committed migrations. Measured at ~1.5s, which is the right trade against a class of false
 * failure that costs hours to diagnose and has already cost some.
 *
 * BOTH SCHEMAS, AND THAT IS NOT A DETAIL. Drizzle keeps `__drizzle_migrations` in its own `drizzle`
 * schema, so dropping `public` alone leaves the ledger claiming every migration is applied and the
 * re-migrate silently does nothing — a rebuild that produces an EMPTY database while reporting
 * success. Proven by measurement: dropping `public` only left 0 tables behind.
 */
export async function resetTestDatabase(
  pool: { query: (q: string) => Promise<unknown> },
  migrate: () => { status: number | null } = () =>
    spawnSync("npm", ["run", "db:migrate"], { stdio: "pipe", env: process.env }),
): Promise<void> {
  await pool.query(
    `DROP SCHEMA IF EXISTS public CASCADE;
     DROP SCHEMA IF EXISTS drizzle CASCADE;
     CREATE SCHEMA public;`);
  const { status } = migrate();
  if (status !== 0) throw new Error(`db:migrate failed while rebuilding the test schema (exit ${status})`);
}

// ── EXECUTION AND COLLECTION ──────────────────────────────────────────────────────────────────

export interface AcceptanceResult { id: string; ok: boolean; code: number | null; note: string }

/**
 * Run every acceptance, each against a freshly reset database, and return one verdict per entry.
 *
 * Nothing here stops early. A failing acceptance is recorded and the next one starts from a clean
 * database — which is the entire point: one red must not hide the evidence behind it, and must not
 * poison it either. The caller decides the exit code from the collected results.
 */
export async function runAcceptances(
  entries: Acceptance[],
  deps: {
    reset: () => Promise<void>;
    run: (cmd: string[]) => { status: number | null };
    log?: (line: string) => void;
  },
): Promise<AcceptanceResult[]> {
  const log = deps.log || (() => {});
  const results: AcceptanceResult[] = [];
  for (const a of entries) {
    log(`\n──────── ${a.id} · ${a.title}`);
    try {
      await deps.reset();
    } catch (e: any) {
      // A reset that fails is not a reason to run the next acceptance against whatever is left —
      // that is the contamination this exists to remove, arriving through the back door.
      results.push({ id: a.id, ok: false, code: null, note: `reset failed: ${e?.message || e}` });
      log(`  RESET FAILED — ${e?.message || e}`);
      continue;
    }
    const { status } = deps.run(a.command);
    const ok = status === 0;
    results.push({ id: a.id, ok, code: status, note: ok ? "" : `exit ${status}` });
    log(`  ${ok ? "GREEN" : `RED (exit ${status})`}`);
  }
  return results;
}

/** The gate: any failure is a failure. Kept separate so a control can assert it directly. */
export function exitCodeFor(results: AcceptanceResult[]): number {
  return results.some(r => !r.ok) ? 1 : 0;
}

export function summarise(results: AcceptanceResult[]): string {
  const width = Math.max(...results.map(r => r.id.length), 4);
  const rows = results.map(r =>
    `  ${r.ok ? "GREEN" : "RED  "}  ${r.id.padEnd(width)}  ${r.note}`.trimEnd());
  const red = results.filter(r => !r.ok);
  return [
    "",
    "══════════════════════════════════════════════════════════════════",
    `PG ACCEPTANCE SUMMARY — ${results.length} run, ${results.length - red.length} green, ${red.length} red`,
    "══════════════════════════════════════════════════════════════════",
    ...rows,
    "",
    red.length
      ? `pg-acceptance: RED — ${red.map(r => r.id).join(", ")}`
      : "pg-acceptance: GREEN — every acceptance executed and passed",
  ].join("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

/**
 * THE WORKING TREE MUST BE CLEAN, BEFORE AND AFTER (B, 2026-09-18).
 *
 * The revert harnesses in this inventory MUTATE files under server/ and restore them from an EXIT
 * trap. A trap does not fire on SIGKILL, and it does not fire if the runner is killed while a
 * harness is mid-case — which happened on 2026-09-17 and left four deliberately-broken mutations
 * stranded in the tree, found one at a time over the following hour. A stranded mutation looks
 * exactly like a real code change in `git status`, and committing one would push a knowingly
 * broken product line.
 *
 * So: refuse to START on a dirty server/ (otherwise a harness's own backup captures the damage and
 * faithfully "restores" it), and FAIL at the end if the tree did not come back clean, naming the
 * files. Advisory only when git is unavailable — this is a guard, not a new dependency.
 */
function dirtyServerFiles(): string[] | null {
  const r = spawnSync("git", ["status", "--porcelain", "--", "server/"], { encoding: "utf-8" });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;   // no git: advisory, not fatal
  return r.stdout.split("\n").map(l => l.trim()).filter(Boolean);
}

async function main() {
  const only = (() => {
    const i = process.argv.indexOf("--only");
    return i >= 0 ? (process.argv[i + 1] || "").split(",").map(x => x.trim()).filter(Boolean) : [];
  })();
  // ONE SUITE, WHEN ONE SUITE IS THE QUESTION. The full inventory is ~50 suites and ~120 revert
  // mutations, each re-running a whole acceptance — roughly an hour. Running all of it to re-check
  // the one cut you just changed is the single largest avoidable cost in this loop; measured, the
  // same question answered with --only took 31 seconds.
  // --shard i/n: run every n-th acceptance starting at i, so CI can split the ~80-minute inventory
  // across n parallel machines. Every acceptance lands in exactly one shard.
  const shard = (() => {
    const i = process.argv.indexOf("--shard");
    if (i < 0) return null;
    const m = /^(\d+)\/(\d+)$/.exec(process.argv[i + 1] || "");
    if (!m || Number(m[1]) >= Number(m[2])) { console.error("pg-acceptance-runner: --shard expects i/n with i < n"); process.exit(2); }
    return { i: Number(m[1]), n: Number(m[2]) };
  })();
  const base = only.length > 0 ? ACCEPTANCES.filter(a => only.includes(a.id)) : ACCEPTANCES;
  const entries = shard ? base.filter((_, idx) => idx % shard.n === shard.i) : base;
  if (shard) console.log(`pg-acceptance-runner: shard ${shard.i}/${shard.n} (${entries.length} of ${base.length} suites)`);
  if (only.length > 0) {
    const unknown = only.filter(id => !ACCEPTANCES.some(a => a.id === id));
    if (unknown.length > 0) {
      console.error(`pg-acceptance-runner: unknown --only id(s): ${unknown.join(", ")}`);
      console.error(`Known ids: ${ACCEPTANCES.map(a => a.id).join(", ")}`);
      process.exit(2);
    }
    console.log(`pg-acceptance-runner: --only ${only.join(", ")} (${entries.length} of ${ACCEPTANCES.length} suites)`);
  }

  const dirtyBefore = dirtyServerFiles();
  if (dirtyBefore && dirtyBefore.length > 0) {
    console.error("pg-acceptance-runner: REFUSING TO RUN — server/ is dirty:");
    console.error(dirtyBefore.map(l => `  ${l}`).join("\n"));
    console.error("The revert harnesses below mutate these files and restore them from a backup");
    console.error("taken at their own start, so starting dirty bakes the current state in as");
    console.error("\"clean\". Commit, or `git checkout -- server/`, first.");
    process.exit(2);
  }

  const safety = testDatabaseSafety(process.env.DATABASE_URL, process.env as any);
  if (!safety.safe) {
    console.error(`pg-acceptance-runner: REFUSING TO RESET — ${safety.reason}.`);
    console.error("This runner truncates every table it can see, so it only ever points at a");
    console.error("throwaway local/CI database. Set DATABASE_URL to one and, outside CI, pass");
    console.error("PG_ACCEPTANCE_ALLOW_RESET=1 to say so deliberately.");
    process.exit(2);
  }

  const { pool } = await import("../server/db");
  const results = await runAcceptances(entries, {
    reset: () => resetTestDatabase(pool),
    // stdio inherited so each acceptance's own PASS/FAIL lines stay in the CI log verbatim —
    // the summary is an index to that output, never a replacement for it.
    run: (cmd) => spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env: process.env }),
    log: (l) => console.log(l),
  });
  console.log(summarise(results));
  await pool.end().catch(() => {});
  // A HARNESS THAT DID NOT RESTORE IS A FAILED RUN, whatever its suites reported. Saying so here is
  // the difference between finding the damage now and finding it in tomorrow's `git status`.
  const dirtyAfter = dirtyServerFiles();
  if (dirtyAfter && dirtyAfter.length > 0) {
    console.error("\npg-acceptance-runner: RED — server/ did not come back clean:");
    console.error(dirtyAfter.map(l => `  ${l}`).join("\n"));
    console.error("A revert harness mutated these and did not restore them. Run `git checkout -- server/`.");
    process.exit(1);
  }
  process.exit(exitCodeFor(results));
}

// Only when executed directly — importing this file for its inventory or its guard must not run it.
if (process.argv[1] && existsSync(process.argv[1]) && process.argv[1].endsWith("pg-acceptance-runner.ts")) {
  await main();
}
