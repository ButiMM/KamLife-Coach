// Sick flow (2026-07-13) — extracted from early-commands.ts for the file-size budget.
// Question-aware, repeat-aware, duration-aware sickness handling: comeback questions
// get the plan; repeat mentions get a short human variant; the FIRST report parses
// the duration, remembers it (sick_until) and holds the whole proactive machine
// (paused_until — every scheduler job checks isPaused). Recovery clears both.

// NO DIRECT DB HANDLE, DELIBERATELY (2026-08-25). `db`, `users` and `eq` were imported here and
// never used — leftovers from the migration that moved this file's writes behind openHold /
// clearHold, so that "how a sick hold is stored" lives in health-state.ts and nowhere else. The
// architecture guard had been reporting this file as an action file that no longer acts on a
// message; that was a stale classification left by that migration, not a lost write.
import { comebackPlan, trainingStateFromUser } from "../adaptive-training";
import { logChat } from "./chat-log";
import { parseSickDays, isReturnFromSicknessQuestion, looksLikeComebackQuestion } from "../utils";
import { scheduleReturnNudge, cancelReturnNudges } from "../reminders";
import { isBareGreeting } from "../constants";
import { readHealthState, openHold, clearHold } from "../health-state";

// ── Precision guards (2026-07-13, cross-intent sweep) ─────────────────────────
// Word PRESENCE is not a sickness report. "Sick of pap" is frustration. "Flu shot"
// is prevention. Someone ELSE being sick ("my sister has the flu", "flu going
// around at work") is context — unless the message ALSO asserts first-person
// sickness. Idioms are scrubbed FIRST because they contain the trigger words.
const SICK_WORDS = /\b(sick|ill|flu|flue|flu.?like|fever|vomit|nausea|nauseous|throwing up|stomach bug|food poison|covid|covid.?19|not well|not feeling well|feeling sick|feeling ill|feel sick|feel ill|i.?m sick|i.?m ill|under the weather|hospital|doctor.?s|clinic|bed rest|body aches|headache.*bad|migraine|tonsil|sore throat|chest.*tight|can.?t breathe|difficulty breathing)\b/i;
/**
 * ONE RECOVERY MATCHER — the client said they are not sick (2026-08-20, phone P0).
 *
 * THERE WERE TWO. This constant accepted a bare "not sick"; the branch that actually CLEARS the
 * hold required the contraction `i'?m not sick`. A client whose voice note transcribed as
 * "I am not sick. I've never been sick." matched the wide one and failed the narrow one — so the
 * coach agreed with him and changed nothing, kept telling him to rest, sent a night-before
 * "you're cleared to get back to it" nudge, and because recordSickState writes `paused_until`
 * alongside `sick_until`, isPaused() suppressed his 06:00 morning for as long as the flag stood.
 *
 * The file's own comment records this being half-fixed once already: "'I'm not sick' … were in
 * the RECOVERED vocabulary at the top of this file but NOT in the clear-list below." The
 * contraction was added. The words a person actually says were not.
 *
 * So: one predicate, used by both readers. It is expressed as SHAPES — a first-person negation of
 * illness, or a statement of being better — rather than a list of literal phrasings, because the
 * list is what failed. Same class of defect as `\bliver\b` against "chicken livers" and `\b`
 * against "2kg": a matcher closed at the wrong end.
 */
const NOT_SICK = /\b(?:i(?:'|’)?m|i\s+am|im|i(?:'|’)?ve|i\s+have)?\s*(?:not|never(?:\s+been)?|no longer)\s+(?:been\s+)?(?:sick|ill|unwell)\b|\bnot\s+sick\s+any\s?more\b/i;
const IS_BETTER = /\b(?:feeling|feel|i(?:'|’)?m|i\s+am|all|much|getting)\s*better\b|\bbetter\s+now\b|\brecovered\b|\bback to normal\b|\bgot better\b|\bover (?:the (?:flu|cold|bug|virus)|it now)\b|\bi(?:'|’)?m\s+(?:fine|ok(?:ay)?|well|healthy)\b/i;
/** Past-tense only — "I was sick last week" is not a claim to be sick now. */
const WAS_SICK = /\b(?:used to be sick|was sick last week)\b/i;

/** The one question: is this person telling me they are NOT sick? */
export function saysRecovered(text: string): boolean {
  const t = String(text || "");
  return NOT_SICK.test(t) || IS_BETTER.test(t) || WAS_SICK.test(t);
}
const RECOVERED = { test: (s: string) => saysRecovered(s) };
// PAST-TENSE REFERENCE (2026-07-27 live disaster): a client said "Now that I'm not sick
// anymore how do we go about my plan?" — got the right plan — then added "But I was sick",
// and the bare word "sick" threw them BACK into the sick flow: training cancelled, check-ins
// paused 3 days. Explaining that you WERE ill is not reporting that you ARE ill. Only a
// present-tense marker (still / today / now / since) makes a past-tense mention current.
const PAST_SICK_REFERENCE = /\b(?:i|we)\s*(?:'?ve\s+)?(?:was|were)\s+(?:so\s+|very\s+|really\s+)?(?:sick|ill|unwell|down)\b|\bwhen i (?:was|got) (?:sick|ill)\b|\bbeen sick\b/i;
const STILL_SICK_MARKER = /\b(still|today|right now|currently|since (?:yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|again)\b/i;
const SICK_SCRUB = /\bsick (?:and tired )?of\b|\bflu (?:shot|vaccine|vaccination|jab)s?\b/gi;
const THIRD_PARTY_SICK = /\b(?:my (?:sister|brother|mom|mum|mother|dad|father|friend|colleague|co-?worker|wife|husband|partner|boyfriend|girlfriend|son|daughter|kids?|child|children|baby|gran(?:ny)?|grandma|grandpa|aunt|uncle|cousin|neighbou?r|boss)|everyone|everybody|people|the whole (?:office|house|family))\b[^.!?]{0,40}\b(?:sick|ill|flu|fever|covid|bug|vomit|not well)|\b(?:flu|covid|a bug|stomach bug|something)\b[^.!?]{0,30}\bgoing (?:a)?round\b/i;
const FIRST_PERSON_SICK = /\bi\s*(?:'?m|am|feel|felt|'?ve got|'?ve been|have|got|caught|woke up)\b[^.!?]{0,30}\b(?:sick|ill|unwell|flu|fever|covid|nauseous|vomiting|throwing up|not well|terrible|awful|a cold|the flu)\b|\bdown with (?:the )?(?:flu|a cold|covid|a bug)\b|\bnot feeling well\b|\bunder the weather\b|\bcan'?t (?:get out of bed|stop (?:vomiting|throwing up))\b/i;

// Sickness attributed to someone else, with no first-person assertion backing it.
function aboutSomeoneElse(s: string): boolean {
  return THIRD_PARTY_SICK.test(s) && !FIRST_PERSON_SICK.test(s);
}

// A BARE "still sick" check-in — essentially just the sickness report, nothing else to
// respond to ("I'm still sick today", "still have the flu"). Anything carrying real
// content — restlessness, a worry, an emotional share ("I feel like I should be walking,
// I'm not used to just sitting around") — is NOT bare: it must reach the sick-aware brain
// for a real, LISTENING reply, never the fixed holding template. Firing the identical
// template at a genuine share was the systemic failure (2026-07-15 screenshot: a
// restlessness/identity share got the exact same words as "I'm still sick today",
// verbatim, 60 seconds apart). Strip the sickness report + filler; if almost nothing is
// left, it's bare and the short template fits; if real words remain, fall through.
function isBareSickCheckin(m: string): boolean {
  const remnant = (m || "")
    .toLowerCase()
    .replace(SICK_SCRUB, " ")
    .replace(SICK_WORDS, " ")
    .replace(/\b(i'?m|i am|im|i|am|is|it|feel(?:s|ing)?|felt|still|again|today|tonight|now|this|morning|afternoon|evening|a|an|bit|so|really|very|just|quite|kinda|kind of|of|hi|hey|hello|coach|yeah|ya|and|but|also|the|to|man|guys?)\b/gi, " ")
    .replace(/[^a-z]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return remnant.length <= 8;
}

// "Feel sick" right after overeating or a hard session is regret/exertion nausea,
// not illness — scrub it UNLESS a hard illness word (fever, flu, vomiting…) backs
// it up. Without this, "ate so much at the party, I feel sick" paused check-ins
// for 3 days.
const REGRET_CONTEXT = /\b(ate|eaten|overate|over-?did|too much|so much|after (?:eating|lunch|dinner|supper|that meal)|party|braai|buffet|workout|session|training|cardio|that run|the gym)\b/i;
const HARD_ILLNESS = /\b(flu|fever|covid|vomit|throwing up|stomach bug|food poison|bed rest|hospital|clinic)\b/i;

// The sickness-mention gate — also used by early-commands for the return-planning guard.
export function looksSickMention(m: string): boolean {
  let s = (m || "").replace(SICK_SCRUB, " ");
  if (REGRET_CONTEXT.test(s) && !HARD_ILLNESS.test(s)) {
    s = s.replace(/\b(?:i\s+)?feel(?:ing)?\s+(?:a bit\s+|so\s+|really\s+)?(?:sick|ill|nauseous)\b|\bnausea(?:ous)?\b/gi, " ");
  }
  // A purely PAST-TENSE mention ("but I was sick") is context, not a new sick report.
  if (PAST_SICK_REFERENCE.test(s) && !STILL_SICK_MARKER.test(s)) return false;
  return SICK_WORDS.test(s) && !RECOVERED.test(s) && !aboutSomeoneElse(s);
}

// One write holds the whole proactive machine (isPaused is checked by every job)
// and remembers the sickness for the brain snapshot + repeat suppression.
async function recordSickState(user: any, notes: string, m: string, minDays = 0): Promise<{ sickDays: number; sickUntil: string; daysSick: number } | null> {
  // minDays floors the hold so a bare "still sick" check-in always EXTENDS the pause a few
  // more days — otherwise paused_until expires after the first estimate and the proactive
  // machine resumes nagging someone who's still in bed (2026-07-22, Kam: "for two weeks
  // I've been telling it I'm sick" and it kept pinging).
  const sickDays = Math.max(parseSickDays(m), minDays);
  void notes; // the state owner reads the row's notes itself
  try {
    // ENTRY, through the one writer. sick_since is set once and preserved across repeat mentions;
    // the storage format lives in health-state.ts and nowhere else.
    const { sickUntil, daysSick } = await openHold(user, sickDays);
    // TEMPORAL LOOP: don't go silent on a sick client — nudge them the evening before they're due back.
    if (user.phoneNumber) scheduleReturnNudge(user.id, user.phoneNumber, sickUntil, "sick").catch((e) => console.error("[SICK] return nudge failed:", e));
    return { sickDays, sickUntil, daysSick };
  } catch (e) {
    console.error("[SICK] failed to persist sick state:", e);
    return null;
  }
}

export async function handleSickFlow(ctx: { message: string; m: string; user: any; capName: string }): Promise<string | null> {
  const { message, m, user, capName } = ctx;
  // ---- SICK / ILL — above-neck vs below-neck rule ----
  const isAboveNeckOnly = /\b(runny nose|blocked nose|stuffy nose|sneezing|sneezy|light cold|mild cold|bit of a cold|slight headache|congested|congestion)\b/i.test(m)
    && !/\b(fever|vomit|nausea|nauseous|throwing up|stomach|chest|flu|covid|body aches|can.?t breathe|diarr|diarrhoea)\b/i.test(m)
    && !aboutSomeoneElse(m);
  const isSick = looksSickMention(m);
  if (isAboveNeckOnly) {
    const aboveNeckReply = `${capName}, above-the-neck rule: runny nose or congestion = light training is fine.\n\nYou can train — but drop the intensity. A 30-min walk, a light session at 60% effort. If you feel worse during warm-up, stop and rest. No heavy lifts, no max effort today.\n\n*Eat well:* protein + fluids. Vitamin C from fruit or juice. You'll be back to full speed in a day or two.`;
    await logChat(user.id, message, aboveNeckReply, "SICK_ABOVE_NECK");
    return aboveNeckReply;
  }
  // THE COMEBACK QUESTION IS ASKED BY SOMEONE WHO IS NO LONGER SICK (2026-07-29 live).
  // This branch used to live INSIDE `if (isSick)` below, which made it unreachable by the only
  // people it was written for: `looksSickMention` deliberately returns false for a PAST illness
  // reference, so it can't re-open sick mode for someone reminiscing — and "how do I train after
  // my illness" is a past illness reference. The guard against re-opening sick mode and the
  // comeback question are the same sentence shape with opposite intent, so the comeback question
  // was swallowed and fell through to the model, which answered a training question with food.
  //
  // It is hoisted, not duplicated. Still gated on illness vocabulary by the detectors themselves,
  // and it still records a first-person report before answering, so nothing is lost either way.
  const healthEarly = readHealthState(user);
  const alreadySickEarly = healthEarly.isSick;
  const notesEarly = user.profileNotes || "";
  // Hoisting cost us one guard that `looksSickMention` used to apply on this path: it rejects
  // an illness that belongs to somebody else. "My wife, after the flu — how do I help?" must
  // never come back with YOUR comeback plan. Re-applied explicitly rather than assumed.
  if (!aboutSomeoneElse(m) && (isReturnFromSicknessQuestion(m) || looksLikeComebackQuestion(m))) {
    // Answering the question must not LOSE the report — "I can't walk today, I'm sick... how
    // does that affect my progress?" both declares and asks. Record first, then answer.
    let backDate = healthEarly.isSick ? healthEarly.sickUntil ?? null : null;
    let heldLine = "";
    if (!alreadySickEarly && FIRST_PERSON_SICK.test(m)) {
      const rec = await recordSickState(user, notesEarly, m);
      if (rec) {
        backDate = rec.sickUntil;
        heldLine = `I've paused your check-ins for ~${rec.sickDays} day${rec.sickDays !== 1 ? "s" : ""} so I'm not nagging you while you rest. `;
      }
    }
    // ALREADY BACK? (2026-07-30 live.) This closed with "when you're ready, just say I'm back and
    // I'll set up your first session" to a man who replied "I've already had two sessions this
    // week, today is my third." The plan assumed session zero because nothing here ever asked
    // whether he had started. trainingStateFromUser owns that question — so ask it.
    const backState = trainingStateFromUser(user);
    const alreadyTraining = backState.daysSinceLastWorkout > 0 && backState.daysSinceLastWorkout <= 7;
    const closer = alreadyTraining
      ? `You're clearly already back in it — so ignore session one and pick up at the stage that matches what you've done. Tell me how today feels and I'll set the loads.`
      : `When you're ready, just say *I'm back* and I'll set up your first session.`;
    const comebackReply = `Good question — here's your comeback plan${capName ? ", " + capName : ""}:\n\n${comebackPlan()}\n\n*Food while sick still counts* — keep logging what you can, no calorie pressure.\n\n${backDate ? `${heldLine}I've got you resting until around *${backDate}*. ` : ""}${closer}`;
    await logChat(user.id, message, comebackReply, "SICK_COMEBACK_PLAN");
    return comebackReply;
  }

  if (isSick) {
    // SICK FLOW REWORK (2026-07-13, the flu screenshots): the old handler fired the
    // SAME template on ANY sickness mention — four verbatim sends in one day, twice in
    // reply to "what happens when I come back?", while proactive jobs kept blasting a
    // healthy-person rhythm. Now: (1) comeback QUESTIONS get the comeback plan — and
    // still RECORD the sickness when the same message reports it; (2) other sick
    // QUESTIONS that don't assert being sick fall through to the sick-aware brain;
    // (3) repeat mentions while already noted sick get a short human variant, never
    // the template again; (4) the FIRST report parses the duration, remembers it, and
    // puts the entire proactive machine on hold via the existing paused_until plumbing.
    const notes = user.profileNotes || "";
    const health = readHealthState(user);
    const alreadySick = health.isSick;

    // MEMORY COMPLAINT (2026-07-19 live: "I said I'm still sick until Monday why did you
    // forget that??" got the full first-report template — re-committing the exact
    // failure they're angry about, ignoring the accusation, and saying "~3 days" instead
    // of their Monday). Own it, lock the date they gave, keep it SHORT — never re-dump.
    const memoryComplaint = /\b(you forgot|forgot that|forgot i|did you forget|why (did|would|do|are) you|already (told|said)|i (told|said) you|i keep (telling|saying)|keep telling you|i already|you (should )?(know|remember)|not listening|weren'?t listening|pay attention|do you (even )?remember)\b/i.test(m);
    if (memoryComplaint) {
      const hasDatePhrase = /\b(until|till|til|through|thru|by|for|next|about|\d+\s*days?|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(m);
      let until = alreadySick ? health.sickUntil ?? null : null;
      if (!alreadySick || hasDatePhrase) {
        const rec2 = await recordSickState(user, notes, m);
        if (rec2) until = rec2.sickUntil;
      }
      const untilLabel = until
        ? new Date(until + "T00:00:00+02:00").toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "short", timeZone: "Africa/Johannesburg" })
        : null;
      const ackReply = `You're right${capName ? ", " + capName : ""} — my mistake, and it's locked in now. ${untilLabel ? `You're resting until *${untilLabel}*` : "You're resting until you're better"} — no training, no step targets till then, nothing on your plate but getting well.\n\nSay *I'm back* when you're ready. 💛`;
      await logChat(user.id, message, ackReply, "SICK_MEMORY_ACK");
      return ackReply;
    }

    // (The comeback branch used to sit here. It is now hoisted above the isSick gate — see the
    // note there — because the people asking it are by definition no longer sick.)

    // A QUESTION that isn't a comeback question never gets a template — templates
    // answering something the person didn't ask WAS the flu-screenshot failure.
    // "Can you train with a fever?" (no first-person report) and any question asked
    // while already noted sick both fall through to the brain, which carries the
    // sick-state snapshot and answers the actual question. The one exception: a
    // FRESH first-person report phrased as a question ("I'm sick, can I train?")
    // — there the template genuinely answers it, and the report must be recorded.
    const asksQuestion = /\?\s*$/.test(m.trim())
      || /^(?:can|could|should|is|are|do|does|will|would|what|how|when|why)\b/i.test(m.trim());
    if (asksQuestion && (alreadySick || !FIRST_PERSON_SICK.test(m))) return null;

    if (alreadySick) {
      // SYSTEMIC FIX (2026-07-15 screenshot): only a BARE "still sick" check-in gets the
      // holding template. A substantive message while sick — restlessness, a worry, an
      // emotional share — must reach the sick-aware brain (gpt-block's SCENARIO_GUIDE
      // holds the rest line AND answers what they actually said). Firing the template at a
      // real share, verbatim, was the failure. Fall through for anything not bare.
      if (!isBareSickCheckin(m)) return null;
      // EXTEND the hold on every bare check-in so the pause never lapses back into nagging
      // while they're clearly still unwell. daysSick tells us how long it's dragged on.
      const held = await recordSickState(user, user.profileNotes || "", m, 3);
      const daysSick = held?.daysSick ?? 0;
      const name = capName ? ", " + capName : "";
      // PROLONGED ILLNESS (2026-07-22): after ~a week of being sick, stop with the same
      // holding lines and show real concern — gently point them to a doctor, without
      // pretending to be one. A week-plus of illness is genuinely worth a check-up.
      const concern = daysSick >= 6
        ? `You've been under the weather for over a week now${name} — that's longer than a normal bug. I'm keeping everything paused, no pressure at all. But please get to a clinic or see a doctor if you haven't yet; a week-plus of feeling sick deserves a proper check. 💛\n\n`
        : "";
      // Even bare check-ins must NOT repeat verbatim (the screenshot showed the identical
      // words twice, 60s apart). Rotate holding lines; every variant holds the rest line
      // and keeps the recovery cues, so the repeat-mention drill still passes.
      const stillSickVariants = [
        `Still resting — that's exactly right${name}. 💛 Fluids, sleep, small meals when you can.\n\nWant the plan for when you're back? Just ask *"what do I do when I'm better?"* — otherwise rest easy, I'm holding everything for you.`,
        `Rest is still the job${name}. 💛 Keep the fluids up, sleep as much as you can, eat what you can keep down.\n\nEverything's paused and waiting — no catch-up, no pressure. Say *I'm back* when you've turned the corner.`,
        `Noted — still holding everything for you${name}. 💛 Water, soup, sleep. Small meals when your appetite allows.\n\nNo rush back. When you're better, just tell me and we pick up exactly where we left off.`,
      ];
      const stillSickReply = concern + stillSickVariants[Math.floor(Date.now() / 1000) % stillSickVariants.length];
      await logChat(user.id, message, stillSickReply, "SICK_STILL");
      return stillSickReply;
    }

    const goal = user.goalType || "fat_loss";
    const programmeRef = user.trainingMode
      ? `Your ${user.trainingMode.replace(/_/g, " ")} programme is saved`
      : "Your programme and targets are saved";
    const rec = await recordSickState(user, notes, m);
    const sickDays = rec?.sickDays ?? parseSickDays(m);

    // A SICK PERSON GETS THREE LINES, NOT A PROTOCOL (2026-08-06 sweep). This used to send a
    // bulleted regimen — sleep, fluids, no steps target — to someone who had just said they
    // were ill and was probably reading it in bed. What they actually need to know is: stop
    // training, eat what you can keep down, nothing you built is lost.
    const nutritionLine = goal === "muscle_gain"
      ? `Eat what you can — protein first, even small amounts.`
      : `Eat small and simple — soup, eggs, toast, whatever stays down. No calorie pressure today.`;
    const sickReply = `${capName}, no training until you're properly better — your body's busy. ${nutritionLine}\n\n${programmeRef} and nothing resets; I've paused your check-ins for ~${sickDays} day${sickDays !== 1 ? "s" : ""}. Say *I'm back* when you're ready.`;
    await logChat(user.id, message, sickReply, "SICK_DAY");
    return sickReply;
  }

  // ---- RECOVERY — "I'm back / feeling better" clears the sick hold ----
  // DEFERRED-DECISION GUARD (2026-07-20 live: "I'll let you know AFTER Monday how I feel
  // about getting back to training" matched "back to training" → "Welcome back!" to a
  // still-sick client). A future/maybe is NOT a recovery declaration — stand down and let
  // the sick-aware brain answer.
  const isDeferredReturn = /\b(i'?ll let you know|let you know (after|by|on|how)|after (mon|tues|wednes|thurs|fri|satur|sun)day|not (yet|now|sure)|maybe|might|thinking (of|about)|will (see|decide)|we'?ll see|if i (feel|am)|once i (feel|am)|when i (feel|am)|hopefully)\b/i.test(m);
  // "I'm not sick" / "I'm fine now" were in the RECOVERED vocabulary at the top of this file but
  // NOT in the clear-list below, so a client correcting the coach ("I'm not sick") could not clear
  // the hold and kept getting sick-adjusted targets every morning (2026-07-28 live).
  // THE SAME PREDICATE THE DETECTOR USES. Two vocabularies for one question is what produced the
  // 19-20 August screenshots; there is now one, and "I'm back" / "ready to train" join it here
  // because those are declarations of return rather than of health.
  const declaresReturn = saysRecovered(m)
    || /\b(i'?m back|i\s+am\s+back|ready to train|back to training|flu'?s? gone|i'?m training (?:today|tomorrow)|i\s+am\s+training (?:today|tomorrow)|never left|haven'?t been (?:gone|away)|never been (?:gone|away))\b/i.test(m);
  // THE EXIT THE MORNING BRIEF ADVERTISES (2026-08-21 live, Kam's handset). A client on a health
  // hold is told at 06:00: "When you're ready, just say Hi and we pick up from where you left
  // off." "Hi" was not a return declaration, so the hold stood and the same message arrived the
  // next morning, and the next. The coach was asking for a password it would not accept.
  //
  // Scoped deliberately to a HEALTH hold, which is the only place that promise is made — a
  // holiday pause never says "say Hi", so a greeting must not end one. And it cannot fire on a
  // client who greets while still ill: looksSickMention runs earlier in this same handler, so
  // "hi, still sick" re-arms the hold instead of reaching here.
  const holdOnRecord = readHealthState(user);
  const greetsBackFromSick = isBareGreeting(m) && holdOnRecord.isSick;
  if (!isDeferredReturn && (declaresReturn || greetsBackFromSick) && holdOnRecord.phase !== "none") {
    try {
      await clearHold(user);
      // Already back — cancel the pending night-before nudge so we don't ping someone who returned early.
      await cancelReturnNudges(user.id).catch((e) => console.error("[SICK] cancel return nudge failed:", e));
    } catch (e) { console.error("[SICK] failed to clear sick state:", e); }
    const backReply = `Welcome back${capName ? ", " + capName : ""} — that's what I like to see. 💪\n\n${comebackPlan()}\n\n[BUTTONS:Today's workout|Log food]`;
    await logChat(user.id, message, backReply, "SICK_RECOVERED");
    return backReply;
  }
  return null;
}
