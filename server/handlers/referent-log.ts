/**
 * REFERENT LOG — resolve "log it" / "had 3 handfuls of it" against the food the verdict
 * just discussed. (2026-07-23 live: the verdict said "reply *log it*", the client said
 * "I just had 3 handfuls of it", and the bot answered "I didn't catch what food that was"
 * — about the food it had JUST analysed.) The verdict parks the referent (media.ts);
 * this consumes it — once — and logs a multiple of the serving through the one write door.
 * Pure parsing lives in food-referent.ts; food-context internals are lazy-imported so the
 * static import graph stays acyclic.
 */

import { db } from "../db";
import { users } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { readPendingFood, clearPendingFood, parseReferentReply } from "../food-referent";
import { logChat } from "./chat-log";

export async function tryLogReferent(ctx: { phone: string; message: string; user: any }): Promise<string | null> {
  const { phone, message, user } = ctx;
  const pending = readPendingFood(user.profileNotes);
  if (!pending) return null;
  const ref = parseReferentReply(message);
  if (!ref) return null;

  const kcal = Math.round(pending.kcal * ref.mult);
  const protein = Math.round(pending.protein * ref.mult);
  const cleared = clearPendingFood(user.profileNotes);
  await db.update(users).set({ profileNotes: cleared }).where(eq(users.id, user.id));
  user.profileNotes = cleared;

  const { commitFoodLog, extractMealLabel } = await import("./food-context");
  const { getSlotContext } = await import("../portion-memory");
  const committed = await commitFoodLog({
    userId: user.id, phone, rawMessage: `${ref.mult}x ${pending.name}`.slice(0, 200),
    source: "referent", kcalInt: kcal, proteinInt: protein, carbsInt: 0, fatInt: 0,
    items: [{ name: pending.name, grams: 0, kcal, protein, category: "referent" }],
    mealLabel: extractMealLabel(message, undefined, { kcal, protein }, user, await getSlotContext(user.id)),
    loggedAt: new Date(),
  });
  const amt = ref.mult === 1 ? "" : ref.mult === 0.5 ? "half of " : `${ref.mult}× `;
  const reply = `Logged ✅ ${amt}${pending.name} — ~${kcal} kcal | ${protein}g protein.\n\n_Today: ${committed.runningCals} kcal | ${committed.runningProtein}g protein._`;
  await logChat(user.id, message, reply, "FOOD_REFERENT_LOG");
  return reply;
}
