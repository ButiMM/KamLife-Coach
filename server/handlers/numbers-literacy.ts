// Numbers-literacy handlers (2026-07-14) — extracted from early-commands for the
// file-size budget. The default is NUMBER-FREE (third-party review: "start everyone
// in number-free mode; power users opt in"). These handlers manage the opt-in:
//   1. SHOW ME THE NUMBERS — a power user opts into figures (sets numbers:full).
//   2. KEEP IT SIMPLE      — a numbers client turns them back off (clears the token).
//   3. CALORIE CONFUSION   — reassure with the plain data-bundle explanation (and
//      turn figures off if they had opted in).
// The mode token (numbers:full = on, else off) is read by the food reply builder.

import { db } from "../db";
import { users, stepLogs } from "../../shared/schema";
import { eq, and, gte } from "drizzle-orm";
import { logChat } from "./chat-log";
import { detectToneSignal } from "../tone-mode";
import { messageSpeaksNumbers, wantsVoiceReplies } from "../numbers-mode";
import { sendWhatsApp } from "../scheduler";
import { sastDayStart, looksLikeSurplusDeficitQuestion } from "../utils";

// SURPLUS/DEFICIT IS MATHS, NOT PROSE (2026-07-17 nightly drill caught the third
// recurrence of this class on the model path). The client's target ALREADY contains
// the goal adjustment — muscle gain sits ~400 above maintenance, fat loss ~450 below
// (the same estimates the snapshot's Energy frame teaches). A model kept answering
// with today's remaining kcal instead; now the answer is computed, never generated.
export async function handleSurplusDeficitQuestion(ctx: { message: string; m: string; user: any }): Promise<string | null> {
  const { message, m, user } = ctx;
  if (!looksLikeSurplusDeficitQuestion(m)) return null;
  const target = user.calorieTarget || 0;
  if (!target) return null;
  const goal = String(user.goalType || "fat_loss").toLowerCase();
  const building = goal === "muscle_gain" || goal === "weight_gain";
  let reply: string;
  if (building) {
    reply = `Your surplus is already built into your target — nothing to add on top. Your body burns roughly ~${target - 400} kcal a day (maintenance), and your ${target} kcal target sits ~400 above that. Eat to ${target} and you ARE in your building surplus.\n\nAnd it's judged on the full day — the kcal still open right now is just space left in the day, not a deficit.`;
  } else if (goal === "fat_loss") {
    reply = `Your deficit is already built into your target — nothing extra to cut. Your body burns roughly ~${target + 450} kcal a day (maintenance), and your ${target} kcal target sits ~450 below that. Finish the day at ${target} and you ARE in your deficit.\n\nIt's judged on the full day — being under target mid-day is normal, the day isn't done yet.`;
  } else {
    reply = `For your goal you eat AT maintenance — your ${target} kcal target IS the plan. No surplus or deficit to chase; hitting that number consistently is the whole game.`;
  }
  // Two-part asks ("what's my surplus and how are my steps today?") answer BOTH halves —
  // dropping half the question reads as not listening (locked drill case).
  if (/\bsteps?\b/i.test(m)) {
    try {
      const row = await db.select({ steps: stepLogs.steps }).from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sastDayStart()))).limit(1);
      const todaySteps = row[0]?.steps ?? 0;
      reply += todaySteps > 0
        ? `\n\nSteps today: ${todaySteps.toLocaleString()} so far vs your ${(user.stepsTarget || 8500).toLocaleString()} target.`
        : `\n\nNo steps logged yet today — send your count when you have it.`;
    } catch { /* the steps half is best-effort; the surplus answer stands alone */ }
  }
  await logChat(user.id, message, reply, "SURPLUS_EXPLAINER");
  return reply;
}

// AUTO OPT-IN BY FLUENCY (2026-07-16 founder: "be brighter than that"). A client who
// speaks in kcal/macros THREE times has voted with their vocabulary — flip them to
// full numbers without making them find the magic phrase. Counter rides in
// profileNotes (numfluent:N, same migration-free pattern as sick_until). Called
// fire-and-forget from routes at message entry, so it counts EVERY text message no
// matter which handler wins, and never blocks or replaces a reply — the one-time
// notice goes out as its own WhatsApp message.
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
  const isCalorieConfusion = /\b(what(?:'?s| is| are)?\s+(?:a |the )?calories?\b|don.?t (understand|get|know)( what)? (calories|kcal|this number|these numbers|the numbers)|calories?.*confus|confus.*calories?|too many numbers|what does (that|this|the number|kcal|calories?) mean|what(?:'?s| is)?\s+a?\s*kcal|explain (the )?calories?|i don.?t count calories|never counted calories)\b/i.test(m)
    || (/\bcalor|kcal\b/i.test(m) && /\b(confused|lost|don.?t understand|makes? no sense|too complicated|i.?m not good with numbers)\b/i.test(m));
  if (isCalorieConfusion) {
    if (isFull) {
      try {
        const base = (user.profileNotes || "").replace(/\s*\bnumbers:(low|full)\b/gi, "").trim();
        await db.update(users).set({ profileNotes: base || null }).where(eq(users.phoneNumber, phone));
      } catch (e) { console.error("[NUMBERS_MODE] confusion → plain failed:", e); }
    }
    const goal = user.goalType || "fat_loss";
    const goalLine = goal === "muscle_gain"
      ? `Yours is set a little *above* what your body burns, so there's extra to build muscle with.`
      : `Yours is set a little *below* what your body burns, so the difference comes off as fat — without you ever going hungry.`;
    const calmReply = `No stress${capName ? `, ${capName}` : ""} — you never have to understand calories or count anything. That's *my* job. 💛\n\nHere's the only picture you need: think of it like a *data bundle for food*. Every day you get a bundle. Every meal uses a little. When I send a number back, that's just *how much bundle is left* — nothing to work out.\n\n${goalLine}\n\nSo you just do the easy part: send me what you eat — a photo or a few words — and I'll tell you in plain language, like *"that's a solid lunch, room for a light dinner."* Deal?`;
    await logChat(user.id, message, calmReply, "CALORIE_EXPLAINER");
    return calmReply;
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
