// Numbers-literacy handlers (2026-07-14) — extracted from early-commands for the
// file-size budget. Three cohesive pieces of the adaptive-delivery decision
// ("speak food, not calories, for the clients who need it"):
//   1. NUMBERS BACK ON  — a plain-mode client asks to see the figures again.
//   2. KEEP IT SIMPLE   — a client explicitly asks for number-free replies.
//   3. CALORIE CONFUSION — a client signals they don't understand calories; we
//      explain in plain terms AND switch them to number-free food replies.
// The mode is a profileNotes token (numbers:low), read by the food reply builder.

import { db } from "../db";
import { users } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { logChat } from "./chat-log";

export async function handleNumbersLiteracy(ctx: { message: string; m: string; user: any; capName: string; phone: string }): Promise<string | null> {
  const { message, m, user, capName, phone } = ctx;
  const isLow = /\bnumbers:low\b/i.test(user.profileNotes || "");

  // ---- NUMBERS BACK ON — a number-free client asks to see the figures again ----
  if (isLow
      && (/\b(show|give|see|want|bring back|turn on|display)\b[^.!?]{0,20}\b(numbers|calories|kcal|macros|the figures|the maths|protein numbers?)\b|\bshow me the (numbers|calories|macros)\b|\bi (want|like) (the |to see )?(numbers|calories|macros)\b/i.test(m))) {
    try {
      const cleaned = (user.profileNotes || "").replace(/\s*\bnumbers:low\b/gi, "").trim();
      await db.update(users).set({ profileNotes: cleaned || null }).where(eq(users.phoneNumber, phone));
    } catch (e) { console.error("[NUMBERS_MODE] clear failed:", e); }
    const backReply = `Done${capName ? `, ${capName}` : ""} — I'll show the calories and protein on your meals again from now on. If it ever gets to be too much, just say *"keep it simple"* and I'll go back to plain words.`;
    await logChat(user.id, message, backReply, "NUMBERS_ON");
    return backReply;
  }

  // ---- KEEP IT SIMPLE — client explicitly asks for plain, number-free replies ----
  if (!isLow
      && /\b(keep it simple|no numbers|hide the numbers|too many numbers|just tell me|plain (words|english|language)|don.?t show me (numbers|calories)|stop with the (numbers|calories))\b/i.test(m)) {
    try {
      const base = (user.profileNotes || "").trim();
      await db.update(users).set({ profileNotes: base ? `${base} numbers:low` : "numbers:low" }).where(eq(users.phoneNumber, phone));
    } catch (e) { console.error("[NUMBERS_MODE] set low (explicit) failed:", e); }
    const simpleReply = `Got it${capName ? `, ${capName}` : ""} — no more numbers. I'll just tell you in plain words: what's a good plate, and what to eat next. You send the food, I handle the rest. 💛\n\nWant the numbers back one day? Just say *"show me the numbers"*.`;
    await logChat(user.id, message, simpleReply, "NUMBERS_OFF");
    return simpleReply;
  }

  // ---- CALORIE CONFUSION — much of this market has never counted a calorie. When
  // someone says they don't get it, drop the number-talk entirely and explain in the
  // two things everyone knows: a data bundle and a plate of food. Fires ANY day (not
  // gated like the onboarding education note), reassures that counting is OUR job, and
  // switches them to number-free food replies going forward. ----
  const isCalorieConfusion = /\b(what(?:'?s| is| are)?\s+(?:a |the )?calories?\b|don.?t (understand|get|know)( what)? (calories|kcal|this number|these numbers|the numbers)|calories?.*confus|confus.*calories?|too many numbers|what does (that|this|the number|kcal|calories?) mean|what(?:'?s| is)?\s+a?\s*kcal|explain (the )?calories?|i don.?t count calories|never counted calories)\b/i.test(m)
    || (/\bcalor|kcal\b/i.test(m) && /\b(confused|lost|don.?t understand|makes? no sense|too complicated|i.?m not good with numbers)\b/i.test(m));
  if (isCalorieConfusion) {
    if (!isLow) {
      try {
        const base = (user.profileNotes || "").trim();
        await db.update(users).set({ profileNotes: base ? `${base} numbers:low` : "numbers:low" }).where(eq(users.phoneNumber, phone));
      } catch (e) { console.error("[NUMBERS_MODE] set low failed:", e); }
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
