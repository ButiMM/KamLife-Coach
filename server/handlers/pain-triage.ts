// Pain-triage answer resolver (2026-07-12/13) — the reply to the ONE question the coach
// asked ("sharp/stabbing, or dull all-over soreness?"). Runs first in early-commands and
// only when mid-triage; the stashed area lives in awaitingInputType ("pain_triage:knee").
// Sharp → injury protocol + the injury is persisted so the programme trains around it.
// Sore → DOMS reassurance. Anything else clears the flag and falls through — zero
// stickiness. Extracted from early-commands.ts for the file-size budget.

import { db } from "../db";
import { users } from "../../shared/schema";
import { eq } from "drizzle-orm";
import { logChat } from "./chat-log";

export async function resolvePainTriage(ctx: { message: string; m: string; user: any }): Promise<string | null> {
  const { message, m, user } = ctx;
  if (!String(user.awaitingInputType || "").startsWith("pain_triage:")) return null;

  const triageArea = String(user.awaitingInputType).split(":")[1] || "the affected area";
  const saidSharp = /\b(sharp|stab|stabbing|shooting|joint|worse|1)\b/i.test(m);
  const saidSore = /\b(sore|stiff|dull|all over|eases|warm|muscle|doms|2)\b/i.test(m);
  await db.update(users).set({ awaitingInputType: null }).where(eq(users.id, user.id)).catch(() => {});

  if (saidSharp && !saidSore) {
    if (triageArea !== "the affected area") {
      const existingInj = (user.injuries || "").toLowerCase();
      if (!existingInj.includes(triageArea)) {
        const updatedInj = user.injuries && user.injuries !== "none" ? `${user.injuries}, ${triageArea}` : triageArea;
        await db.update(users).set({ injuries: updatedInj }).where(eq(users.id, user.id)).catch(() => {});
      }
    }
    const sharpReply = `That's the one we take seriously. Stop loading ${triageArea === "the affected area" ? "it" : `your ${triageArea}`} — today's session changes, it doesn't die. I've noted it, so your workouts train *around* it from now on.\n\nIce 15 min if swollen. If it's severe or doesn't settle within 48 hours, see a doctor or physio — never train through sharp pain.\n\nReply *workout* and I'll give you today's session built around it.\n\n[BUTTONS:Today's workout|Log food]`;
    await logChat(user.id, message, sharpReply, "INJURY");
    return sharpReply;
  }
  if (saidSore) {
    const soreReply = `Good news — that's *DOMS* (normal muscle soreness), not an injury. It means the training is working: your muscles are adapting.\n\n✅ Train — it eases as you warm up\n✅ Light walking speeds recovery\n✅ Protein — your muscles are rebuilding right now\n\nIt peaks around day 2 and fades by day 3. If it's ever *sharp* or in a *joint*, tell me straight away — that's a different story.\n\n[BUTTONS:Today's workout|Log food]`;
    await logChat(user.id, message, soreReply, "DOMS");
    return soreReply;
  }
  // Changed topic — flag already cleared; caller falls through to normal handling.
  return null;
}
