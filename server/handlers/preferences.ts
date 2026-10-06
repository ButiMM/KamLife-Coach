/**
 * PREFERENCES, PLANS AND SCOPE RAILS — the writers that outlived their files (wave-1 deletion, CTO 6 Oct).
 *
 * numbers-literacy.ts and advice-commands.ts were delete-list files: their coaching prose became the
 * new coach's (A16) and the files go. What they still OWNED is kept here verbatim, because each one
 * either writes state the rest of the product reads, or carries a medical-scope guarantee:
 *   - numbers on/off, tone, voice replies on/off, and the two auto-offers (profileNotes tokens);
 *   - the return day a client names (back_on + the evening-before nudge) and the step target;
 *   - the digestive-issue and health-quick-fix boundaries ("your doctor decides", never a cure promise).
 */
import { db } from "../db";
import { users } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { logChat } from "./chat-log";
import { detectToneSignal } from "../tone-mode";
import { messageSpeaksNumbers, wantsVoiceReplies } from "../numbers-mode";
import { sendWhatsApp } from "../scheduler";
import { looksSickMention } from "./sick-flow";
import { nextDayDate, extractStepTargetChange, looksLikeDigestiveIssue } from "../utils";

export async function bumpNumericFluency(user: any, m: string, phone: string): Promise<void> {
  try {
    const notes = user?.profileNotes || "";
    if (/\bnumbers:full\b/i.test(notes)) return; // already opted in
    if (!messageSpeaksNumbers(m)) return;
    const count = parseInt((notes.match(/\bnumfluent:(\d+)\b/i) || [])[1] || "0", 10) + 1;
    if (count >= 3) {
      const base = notes.replace(/\s*\bnumfluent:\d+\b/gi, "").replace(/\s*\bnumbers:(low|full)\b/gi, "").trim();
      await db.update(users).set({ profileNotes: base ? `${base} numbers:full` : "numbers:full" }).where(eq(users.phoneNumber, phone));
      const notice = `I've noticed you speak calories 📊 — so from now on I'll show the full numbers (kcal + protein) on every meal. If it ever gets to be too much, just say *"keep it simple"* and I'll go back to plain words.`;
      await sendWhatsApp(phone, notice);
      await logChat(user.id, "[system: numeric fluency detected]", notice, "NUMBERS_AUTO_ON");
    } else {
      const base = notes.replace(/\s*\bnumfluent:\d+\b/gi, "").trim();
      await db.update(users).set({ profileNotes: base ? `${base} numfluent:${count}` : `numfluent:${count}` }).where(eq(users.phoneNumber, phone));
    }
  } catch (e) {
    console.warn("[NUMERIC_FLUENCY] non-fatal:", (e as Error)?.message || e);
  }
}

// TONE PREFERENCE (2026-07-14) — a client who asks for a different voice ("just tell
// me straight", "be gentle with me", "push me") gets it set as a durable tone: token,
// which flexes the coaching brain's voice. Sits with the numbers handlers because both
// are adaptive-delivery preferences.
export async function handleToneSignal(ctx: { message: string; m: string; user: any; capName: string; phone: string }): Promise<string | null> {
  const { message, m, user, capName, phone } = ctx;
  const signal = detectToneSignal(m);
  if (!signal) return null;
  const cap = capName ? `, ${capName}` : "";
  try {
    const base = (user.profileNotes || "").replace(/\s*\btone:(gentle|direct|hype)\b/gi, "").trim();
    await db.update(users).set({ profileNotes: base ? `${base} tone:${signal}` : `tone:${signal}` }).where(eq(users.phoneNumber, phone));
  } catch (e) { console.error("[TONE_MODE] set failed:", e); }
  const reply = signal === "direct"
    ? `Got it${cap} — straight talk from now on, no fluff. Just the answer and the next move.`
    : signal === "hype"
      ? `Let's go${cap} 🔥 — I'll push you and shout every win from the rooftops. Time to work.`
      : `Of course${cap} 💛 — I'll keep it gentle and go at your pace. Small steps, no pressure, ever. You've got this.`;
  await logChat(user.id, message, reply, "TONE_PREF");
  return reply;
}

export async function handleNumbersLiteracy(ctx: { message: string; m: string; user: any; capName: string; phone: string }): Promise<string | null> {
  const { message, m, user, capName, phone } = ctx;
  // WAVE-1 SWITCH: for a switched client the new coach explains the numbers (A16), from the ledger.
  // Default is number-free (numbers:low or absent); numbers:full = opted into figures.
  const isFull = /\bnumbers:full\b/i.test(user.profileNotes || "");

  // ---- SHOW ME THE NUMBERS — a client opts INTO the figures (power user) ----
  // PLAN-CONTEXT GUARD (2026-07-20 live: "give me NUMBERS on how we are going to go about
  // it" = asking for their PLAN, not a display preference — this toggle hijacked it). When
  // the message is about a plan/approach, stand down: the brain answers the actual ask.
  const isPlanAsk = /\b(plan|programme|program|roadmap|go about|how (we|are we|you)|strategy|approach|ease (me )?back)\b/i.test(m);
  if (!isFull && !isPlanAsk
      && (/\b(show|give|see|want|bring back|turn on|display)\b[^.!?]{0,20}\b(numbers|calories|kcal|macros|the figures|the maths|protein numbers?|the detail|the breakdown)\b|\bshow me the (numbers|calories|macros|detail)\b|\bi (want|like) (the |to see )?(numbers|calories|macros|detail)\b|\bgive me the (numbers|detail|breakdown|macros)\b/i.test(m))) {
    try {
      const base = (user.profileNotes || "").replace(/\s*\bnumbers:(low|full)\b/gi, "").trim();
      await db.update(users).set({ profileNotes: base ? `${base} numbers:full` : "numbers:full" }).where(eq(users.phoneNumber, phone));
    } catch (e) { console.error("[NUMBERS_MODE] set full failed:", e); }
    const backReply = `Done${capName ? `, ${capName}` : ""} — I'll show the calories and protein on every meal from now on. 📊 If it ever gets to be too much, just say *"keep it simple"* and I'll go back to plain words.`;
    await logChat(user.id, message, backReply, "NUMBERS_ON");
    return backReply;
  }

  // ---- "JUST THE PLAN" — the other half of the onboarding question (2026-08-05) ----
  // Onboarding now ASKS, with buttons, instead of burying the choice in italic small print
  // nobody read. A client who taps "Just the plan" is ALREADY number-free, so there is no
  // state to change — but silence on a button they just pressed reads as a broken button.
  // Confirm the choice and tell them the door back, once.
  //
  // Note this must sit AFTER the opt-in branch: "just the plan" trips the isPlanAsk guard
  // there, which correctly stands that branch down rather than opting them in.
  if (!isFull && /\b(just the plan|no numbers|keep it simple|plain (words|english)|skip the numbers)\b/i.test(m)) {
    const planReply = `Perfect${capName ? `, ${capName}` : ""} — plain words it is. I'll tell you what's a good plate and what to eat next, and I'll keep the counting on my side. Want the numbers one day? Just say *"show me the numbers"*.`;
    await logChat(user.id, message, planReply, "NUMBERS_STAY_OFF");
    return planReply;
  }

  // ---- KEEP IT SIMPLE — a numbers client turns the figures back off ----
  if (isFull
      && /\b(keep it simple|no numbers|hide the numbers|too many numbers|just tell me|plain (words|english|language)|don.?t show me (numbers|calories)|stop with the (numbers|calories)|turn off the numbers)\b/i.test(m)) {
    try {
      const base = (user.profileNotes || "").replace(/\s*\bnumbers:(low|full)\b/gi, "").trim();
      await db.update(users).set({ profileNotes: base || null }).where(eq(users.phoneNumber, phone));
    } catch (e) { console.error("[NUMBERS_MODE] back to plain failed:", e); }
    const simpleReply = `Got it${capName ? `, ${capName}` : ""} — no more numbers. I'll just tell you in plain words: what's a good plate, and what to eat next. You send the food, I handle the rest. 💛\n\nWant the numbers back one day? Just say *"show me the numbers"*.`;
    await logChat(user.id, message, simpleReply, "NUMBERS_OFF");
    return simpleReply;
  }

  // ---- CALORIE CONFUSION — the client is already number-free by default; if they
  // somehow have figures on (opted in, then overwhelmed) turn them off, and either
  // way give the reassuring data-bundle explanation. Counting is OUR job, never theirs.
  /**
   * A BARE PRONOUN NAMES NO SUBJECT (#114 P1, 2026-09-03, founder).
   *
   * This alternation used to read `what does (that|this|the number|kcal|calories?) mean`, so
   * "what does that mean" claimed the turn unconditionally — with no calorie word anywhere in it.
   * A client who had just been told "7.0kg to go: 92kg now, 85kg the goal" and asked what that
   * meant was answered: "you never have to understand calories or count anything." The active
   * subject was weight; the coach delivered a lecture on a subject nobody had raised.
   *
   * "the number", "kcal" and "calories" say what they are about and still claim. "that" and
   * "this" say nothing, so they are not this handler's to answer — a follow-up whose subject is
   * whatever was just discussed belongs to the path that can see the conversation. The second
   * clause below is unchanged and still catches a pronoun beside a real calorie word
   * ("I'm confused, what does that mean about my calories").
   */
  const isCalorieConfusion = /\b(what(?:'?s| is| are)?\s+(?:a |the )?calories?\b|don.?t (understand|get|know)( what)? (calories|kcal|this number|these numbers|the numbers)|calories?.*confus|confus.*calories?|too many numbers|what does (the number|the numbers|kcal|calories?) mean|what(?:'?s| is)?\s+a?\s*kcal|explain (the )?calories?|i don.?t count calories|never counted calories)\b/i.test(m)
    || (/\bcalor|kcal\b/i.test(m) && /\b(confused|lost|don.?t understand|makes? no sense|too complicated|i.?m not good with numbers)\b/i.test(m));
  if (isCalorieConfusion) {
    if (isFull) {
      try {
        const base = (user.profileNotes || "").replace(/\s*\bnumbers:(low|full)\b/gi, "").trim();
        await db.update(users).set({ profileNotes: base || null }).where(eq(users.phoneNumber, phone));
      } catch (e) { console.error("[NUMBERS_MODE] confusion → plain failed:", e); }
    }
    // The preference change above stays; the explanation is the new coach's (#445, A16).
  }

  return null;
}

// VOICE REPLIES (2026-08-03) — the second delivery dial, and the one this market
// actually needs. Kam's clients send him voice notes because typing is work; the
// coach has only ever written back. Reviewer #1 item 8 asked for this as an OPT-IN,
// not a default, because TTS on every reply is not a marginal cost — so the token
// is `voice:on` and its absence means text only, exactly like numbers:full.
// ONE regex, two directions (the architecture guard refused a second literal, correctly —
// "does the client want voice?" is one question and one question gets one owner).
const VOICE_PREF = /\b(?<on>talk to me|speak to me|voice ?note me|send (?:me )?voice ?notes?|reply (?:with|in) (?:a )?voice|answer (?:me )?(?:with|in) voice|read it to me|say it out loud|i (?:can.?t|cannot|struggle to) read|i don.?t read (?:well|good)|voice ?notes? please)|(?<off>text only|no voice ?notes?|stop the voice ?notes?|don.?t send (?:me )?voice|no more voice|just (?:type|write|text)(?: it)?|writing only)\b/i;

export async function handleVoiceReplyPreference(ctx: { message: string; m: string; user: any; capName: string; phone: string }): Promise<string | null> {
  const { message, m, user, capName, phone } = ctx;
  const on = wantsVoiceReplies(user);
  // A delivery preference is a COMMAND, not a paragraph. Without this, "I just need someone
  // to talk to me" from a client in a bad place would be answered with a settings
  // confirmation — the exact opposite of what that moment needs.
  if (m.length > 60) return null;
  const said = VOICE_PREF.exec(m)?.groups;
  if (!said) return null;
  const cap = capName ? `, ${capName}` : "";
  const setNotes = async (value: string | null) => {
    const base = (user.profileNotes || "").replace(/\s*\bvoice:on\b/gi, "").trim();
    const next = value ? (base ? `${base} ${value}` : value) : (base || null);
    await db.update(users).set({ profileNotes: next }).where(eq(users.phoneNumber, phone));
  };

  // ON. "I can't read" is deliberately in here: a client admitting that is the exact
  // person this feature exists for, and asking them to find a magic phrase would be
  // the opposite of the point.
  if (!on && said.on) {
    try { await setNotes("voice:on"); } catch (e) { console.error("[VOICE_MODE] on failed:", e); }
    const reply = `Done${cap} 🎤 — I'll send you a voice note with my replies from now on, and the text underneath so you can look back at it.\n\nIf you ever want just the writing, say *"text only"*.`;
    await logChat(user.id, message, reply, "VOICE_ON");
    return reply;
  }

  // OFF.
  if (on && said.off) {
    try { await setNotes(null); } catch (e) { console.error("[VOICE_MODE] off failed:", e); }
    const reply = `Got it${cap} — writing only from now on. Say *"talk to me"* any time you want the voice back.`;
    await logChat(user.id, message, reply, "VOICE_OFF");
    return reply;
  }

  return null;
}

// AUTO-OFFER, never auto-enable. A client who has sent THREE voice notes has told us
// how they prefer to communicate — but voice costs money per reply, so we ask instead
// of assuming. Same counter shape as numfluent: a profileNotes token, no migration,
// fire-and-forget from the audio branch so it never delays a reply.
export async function bumpVoiceNoteUse(user: any, phone: string): Promise<void> {
  try {
    const notes = user?.profileNotes || "";
    if (/\bvoice:(on|asked)\b/i.test(notes)) return; // already on, or already offered once
    const count = parseInt((notes.match(/\bvoicein:(\d+)\b/i) || [])[1] || "0", 10) + 1;
    const base = notes.replace(/\s*\bvoicein:\d+\b/gi, "").trim();
    if (count >= 3) {
      await db.update(users).set({ profileNotes: base ? `${base} voice:asked` : "voice:asked" }).where(eq(users.phoneNumber, phone));
      const offer = `I've noticed you prefer talking over typing 🎤\n\nWant me to reply in voice notes too? Just say *"talk to me"* and I'll speak my answers — the writing still comes with it.`;
      await sendWhatsApp(phone, offer);
      await logChat(user.id, "[system: voice-note preference detected]", offer, "VOICE_OFFER");
    } else {
      await db.update(users).set({ profileNotes: base ? `${base} voicein:${count}` : `voicein:${count}` }).where(eq(users.phoneNumber, phone));
    }
  } catch (e) {
    console.warn("[VOICE_PREF] non-fatal:", (e as Error)?.message || e);
  }
}

/** The client's own plans and the scope rails that must answer whoever else would (from advice-commands.ts). */
export async function handlePlansAndScope(ctx: { message: string; m: string; user: any; phone: string }): Promise<string | null> {
  const { message, m, user, phone } = ctx;
  const capName = user.name?.split(" ")[0] || "there";
  const isSick = looksSickMention(m);

  // ---- RETURN PLANNING ("I'll be back Wednesday", "let's confirm I go back Monday") ----
  const isReturnPlanning = /\b(i.?ll (be back|start|resume|return|train|come back)|let.?s confirm|confirm (i|that i)|going back|back (on|from) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)|start(ing)? (again|back|monday|tuesday|wednesday|thursday|friday|tomorrow)|resume (on|from|monday|tuesday|wednesday|thursday|friday)|back to (training|gym|it) (on|from|monday|tuesday|wednesday|thursday|friday))\b/i.test(m)
    && !isSick
    && /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|next month)\b/i.test(m);
  // MEMORY (always, whoever replies): persist the stated return day as back_on:<date> — surfaced in the snapshot so the brain REMEMBERS it (2026-07-20 Kam).
  const rpDay = isReturnPlanning ? m.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)\b/i) : null;
  const rpDate = rpDay ? nextDayDate(rpDay[0]) : null;
  if (rpDate && user.id) {
    const rpBase = (user.profileNotes || "").replace(/\s*\|?\s*back_on:\d{4}-\d{2}-\d{2}/g, "").trim();
    const rpNotes = `${rpBase ? rpBase + " | " : ""}back_on:${rpDate}`;
    db.update(users).set({ profileNotes: rpNotes }).where(eq(users.id, user.id)).then(() => { user.profileNotes = rpNotes; }).catch((e: any) => console.error("[RETURN_PLAN] persist failed:", e));
    // TEMPORAL LOOP: nudge them the evening before they said they'd be back, so we never go silent.
    import("../reminders").then(({ scheduleReturnNudge }) => scheduleReturnNudge(user.id, phone, rpDate, "away")).catch((e: any) => console.error("[RETURN_PLAN] nudge failed:", e));
  }

  // UPDATE STEP TARGET — ONE parser (utils.extractStepTargetChange) shared with the brain gate; all SA number formats caught + persisted (2026-07-12).
  const parsedStepTarget = extractStepTargetChange(m);
  if (parsedStepTarget !== null) {
    if (parsedStepTarget >= 2000 && parsedStepTarget <= 30000) {
      const oldTarget = user.stepsTarget || 8500;
      await db.update(users).set({ stepsTarget: parsedStepTarget }).where(eq(users.phoneNumber, phone));
      const direction = parsedStepTarget > oldTarget ? "raised" : parsedStepTarget < oldTarget ? "lowered" : "kept";
      const stepUpdateReply = `Step target ${direction} to *${parsedStepTarget.toLocaleString()} steps/day*. ✅ Every screenshot you log — and your morning brief — now tracks against this.`;
      await logChat(user.id, message, stepUpdateReply, "STEP_TARGET_UPDATE");
      return stepUpdateReply;
    }
    return `That step count doesn't look right (valid range: 2,000–30,000). What should your daily step goal be?`;
  }

  // ---- DIGESTIVE ISSUES — bloating / acid reflux / heartburn / indigestion (2026-07-12
  // onboarding screenshot). Care first, practical food guidance, and a defer-to-doctor
  // safety line. Detector (utils.looksLikeDigestiveIssue) excludes period + check-in noise.
  // NOT GATED — same reason: it carries the "check with your doctor, I work alongside
  // them, never instead of them" line, which is a scope boundary, not coaching flavour.
  if (looksLikeDigestiveIssue(m)) {
    const giReply = `Thanks for telling me${capName ? ", " + capName : ""} — that matters, and we can work with it. 💛\n\nBloating, reflux and heartburn are really common. What helps most people:\n• *Smaller meals, more often* — big meals overload the gut.\n• Eat *slower*, sit up, and don't lie down for 2–3 hours after eating.\n• Common triggers: fizzy drinks, very fatty/fried food, too much dairy, big late-night meals, eating in a rush.\n• Sip water *between* meals, not gulping during.\n\nI'll keep your meals lighter and easier on your stomach. If it's regular or you're already on tablets for it, please also check in with your doctor — I work *alongside* them, never instead of them.\n\nTell me when it hits worst and I'll help you spot the trigger.`;
    await logChat(user.id, message, giReply, "DIGESTIVE_ISSUE");
    return giReply;
  }

  // ---- HEALTH QUICK-FIX EXPECTATION — "will losing weight fix my BP/sugar fast?" ----
  // (2026-07-23, Kam: clients with health problems expect a two-week cure, quit when the
  // miracle doesn't come. Honest timeline up front keeps them — or filters them on day one.)
  const isHealthQuickFix =
    /\b(blood\s*pressure|bp|diabetes|diabetic|sugar\s+(?:is|levels?|problem)|cholesterol|knees?\s+(?:pain|hurt|problem))\b/i.test(m)
    && /\b(fix|cure|heal|sort(?:\s+out)?|go\s+away|reverse|help)\b/i.test(m)
    && /\b(weight|fat|slim|lose|losing|kg)\b/i.test(m);
  // NOT GATED (2026-08-03). This carries a MEDICAL-SCOPE GUARANTEE — the honest timeline and
  // "medication decisions stay with your doctor". It sat behind the engine flag, which has
  // been on in production for weeks, so it never ran: a client asking whether losing weight
  // fixes their blood pressure got whatever the model improvised, with no guaranteed doctor
  // referral. A safety guarantee must never depend on a feature flag being off.
  if (isHealthQuickFix) {
    const healthReply = `${capName}, straight answer: *yes, losing weight genuinely improves this* — blood pressure, sugar control, joint load all respond to fat loss. Doctors see it every day.\n\nBut I owe you the honest timeline: the real improvements show up after roughly *5–10% of your body weight* comes off and stays off — that's a *12-week-plus steady project*, not a two-week fix. Anyone promising faster is selling something.\n\nWhat you'll notice early (weeks 1–3): better energy, better sleep, clothes easing. The clinic numbers follow the consistency.\n\nTwo rules while we work:\n• Keep seeing your doctor — medication decisions stay with them, always.\n• Our lane: food logged, steps walked, strength trained — every day, boring, effective.\n\nIf you're in for the real timeline, I'm in with you the whole way.`;
    await logChat(user.id, message, healthReply, "HEALTH_QUICK_FIX");
    return healthReply;
  }

  return null;
}
