// ACTIVATION MOMENT (2026-07-14, founder + VC review: "obsess over the first five
// minutes — people must know exactly what to expect, and stay calm").
//
// Two halves, both here:
//  1. The onboarding EXPECTATION-SETTER (buildActivationBrief) — a calm, clear "here's
//     how this works, what's required, don't panic, what to expect if you show up, at
//     your own pace" message delivered the moment they finish signing up.
//  2. The FIRST-ACTION celebration (firstActionCelebration) — the "oh wow": the very
//     first time a member logs anything, we make them FEEL that they just did the whole
//     job. Fires exactly once, tracked by an `activated:1` profileNotes token.

import { db } from "./db";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";

export function isActivated(user: any): boolean {
  return /\bactivated:1\b/i.test(user?.profileNotes || "");
}

// The calm expectation-setter shown at the end of onboarding. Number-free, plain, and
// honest about effort being theirs — so nobody panics and everybody knows the deal.
export function buildActivationBrief(firstName?: string): string {
  const name = firstName ? `, ${firstName}` : "";
  return `*How this works${name} — read this once, then relax:*\n\n`
    + `1️⃣ *Your only job:* tell me what you eat, and how the day went. A photo, a voice note, or a few words. That's it. I do all the thinking — you never count a thing.\n`
    + `2️⃣ *Don't panic.* You will not be perfect, and you don't need to be. Miss a day? Just come back — that's the whole secret. Nothing resets, ever.\n`
    + `3️⃣ *What to expect if you show up:* the first 30 days aren't about a new body — they're about proving you can be consistent. Do that, and the body follows. Every time.\n`
    + `4️⃣ *It's yours to drive.* I'll guide, remind, and adjust — but the showing up is on you. That's what makes it real.\n\n`
    + `Deal? Then let's start right now 👇`;
}

// Fires the FIRST time a NEW member logs anything. Returns a celebration to append
// (once), or "" otherwise. Side effect: sets the activated:1 token.
export async function firstActionCelebration(user: any, phone: string, what: "meal" | "workout" | "steps"): Promise<string> {
  if (!user?.id || isActivated(user)) return "";
  // Only genuinely new accounts — never tell a day-60 member "your first meal!" just
  // because they predate the activated: token. New = created within the last 7 days.
  const created = user.createdAt ? new Date(user.createdAt).getTime() : 0;
  if (!created || Date.now() - created > 7 * 86_400_000) return "";
  try {
    const base = (user.profileNotes || "").trim();
    await db.update(users).set({ profileNotes: base ? `${base} activated:1` : "activated:1" }).where(eq(users.phoneNumber, phone));
    if (user.profileNotes !== undefined) user.profileNotes = base ? `${base} activated:1` : "activated:1";
  } catch (e) {
    console.error("[ACTIVATION] mark failed:", e);
    return ""; // if we couldn't persist, don't celebrate (it'd repeat)
  }
  const thing = what === "workout" ? "session" : what === "steps" ? "step count" : "meal";
  return `\n\n🎉 *That's it — your first ${thing} logged. You just did the entire job.*\n`
    + `No counting, no app, no stress — you send it, I handle the rest. Do exactly this, show up, and in 30 days you'll have proven something to yourself. I've got everything else. 💛`;
}
