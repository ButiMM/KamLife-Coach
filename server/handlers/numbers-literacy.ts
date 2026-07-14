// Numbers-literacy handlers (2026-07-14) — extracted from early-commands for the
// file-size budget. The default is NUMBER-FREE (third-party review: "start everyone
// in number-free mode; power users opt in"). These handlers manage the opt-in:
//   1. SHOW ME THE NUMBERS — a power user opts into figures (sets numbers:full).
//   2. KEEP IT SIMPLE      — a numbers client turns them back off (clears the token).
//   3. CALORIE CONFUSION   — reassure with the plain data-bundle explanation (and
//      turn figures off if they had opted in).
// The mode token (numbers:full = on, else off) is read by the food reply builder.

import { db } from "../db";
import { users } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { logChat } from "./chat-log";
import { detectToneSignal } from "../tone-mode";

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
  if (!isFull
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
