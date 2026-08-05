/**
 * STORED-TARGET BACKFILL (2026-08-05).
 *
 * WHY THIS EXISTS. `maintenanceKcal`'s activity multiplier was a map of job titles —
 * `office: 1.3`, the sedentary-no-exercise figure — applied to clients who train three times a
 * week. Maintenance came out ~380 kcal low for everyone, and every target in the product is
 * built on maintenance. Commit 54482ef derives the multiplier from training days instead, so a
 * client onboarding today gets the right number.
 *
 * `calorie_target` is a COLUMN. Rows written before that commit still hold the old figure, and
 * no formula change can reach them. This walks every row and rewrites it.
 *
 * TELL THEM, DO NOT JUST CHANGE IT. A client's calories changing silently is exactly what the
 * weight-trend auto-adjust was disabled for; a backfill that did it quietly would be the same
 * sin wearing a different name. Every corrected client gets one message saying what changed and
 * why, in their coach's voice — not a system notice.
 *
 *   DRY RUN (default — reads, computes, writes NOTHING, sends NOTHING):
 *     npx tsx script/backfill-targets.ts
 *
 *   APPLY (writes the rows, and sends the notes unless --silent):
 *     npx tsx script/backfill-targets.ts --apply
 *     npx tsx script/backfill-targets.ts --apply --silent
 *
 * Run it from the Railway console, where DATABASE_URL and the Twilio credentials already exist.
 * Idempotent: a second run finds nothing to change and says so.
 */

import { eq } from "drizzle-orm";
import { db } from "../server/db";
import { users } from "../shared/schema";
import { recalcTargetsForProfile } from "../server/targets";

const APPLY = process.argv.includes("--apply");
const SILENT = process.argv.includes("--silent");

/**
 * The note the client reads. One sentence on what changed, one on what it means for them —
 * the same voice rules every other reply obeys. No "system", no "recalculated by the
 * algorithm", no apology. A coach telling them their numbers moved and why.
 */
function noteFor(name: string, goalType: string, newCal: number): string {
  const first = (name || "").split(" ")[0];
  const hi = first ? `${first}, ` : "";
  const why = (goalType || "").toLowerCase() === "muscle_gain"
    ? "That's the fuel to actually build, not just hold."
    : "Enough to lose fat without losing muscle.";
  return `${hi}I've recalibrated your daily target for your training schedule — *${newCal} kcal* a day. ${why}`;
}

async function main() {
  console.log(`\nSTORED-TARGET BACKFILL — ${APPLY ? "APPLY (writing rows)" : "DRY RUN (nothing will be written)"}\n`);

  const rows = await db.select().from(users);
  console.log(`${rows.length} client rows read.\n`);

  let changed = 0, unchanged = 0, skipped = 0, notified = 0;
  const changes: Array<{ phone: string; name: string; from: number; to: number; goal: string }> = [];

  for (const u of rows as any[]) {
    // A row with no weight cannot be computed from — mid-onboarding, or a test row. Left alone
    // rather than guessed at: a fabricated target is worse than a missing one.
    if (!u.currentWeight || !u.heightCm || !u.age) { skipped++; continue; }

    let next: { calorieTarget: number; proteinTarget: number; stepsTarget: number };
    try {
      next = recalcTargetsForProfile(u);
    } catch (e) {
      console.warn(`  ⚠️  ${String(u.phoneNumber || "").slice(-4)} — could not compute, left alone: ${(e as any)?.message || e}`);
      skipped++;
      continue;
    }

    const same = u.calorieTarget === next.calorieTarget
      && u.proteinTarget === next.proteinTarget
      && u.stepsTarget === next.stepsTarget;
    if (same) { unchanged++; continue; }

    changed++;
    changes.push({
      phone: String(u.phoneNumber || ""), name: u.name || "",
      from: u.calorieTarget ?? 0, to: next.calorieTarget, goal: u.goalType || "fat_loss",
    });
    const delta = next.calorieTarget - (u.calorieTarget ?? 0);
    console.log(`  ${String(u.phoneNumber || "").slice(-4)}  ${(u.name || "—").slice(0, 18).padEnd(18)} `
      + `${String(u.calorieTarget ?? "—").padStart(5)} → ${String(next.calorieTarget).padStart(5)} kcal `
      + `(${delta >= 0 ? "+" : ""}${delta})  protein ${u.proteinTarget ?? "—"} → ${next.proteinTarget}`);

    if (APPLY) {
      await db.update(users).set({
        calorieTarget: next.calorieTarget,
        proteinTarget: next.proteinTarget,
        stepsTarget: next.stepsTarget,
      }).where(eq(users.id, u.id));
    }
  }

  console.log(`\n${changed} to correct · ${unchanged} already right · ${skipped} skipped (incomplete profile)\n`);

  if (!APPLY) {
    console.log("DRY RUN — nothing was written. Re-run with --apply to write these rows.\n");
    process.exit(0);
  }

  if (SILENT) {
    console.log("--silent — rows written, no client was told. Tell them yourself; do not leave this silent.\n");
    process.exit(0);
  }

  // The notes. Sent AFTER every row is written, so a send failure can never leave a client
  // holding a message about a change that did not happen.
  const { sendWhatsApp } = await import("../server/scheduler/shared");
  for (const c of changes) {
    try {
      await sendWhatsApp(c.phone, noteFor(c.name, c.goal, c.to));
      notified++;
      console.log(`  → told ${c.phone.slice(-4)}: ${c.to} kcal`);
    } catch (e) {
      console.error(`  ✗ could not tell ${c.phone.slice(-4)} — TELL THEM YOURSELF: ${(e as any)?.message || e}`);
    }
  }

  console.log(`\n✅ ${changed} rows corrected, ${notified} clients told.\n`);
  process.exit(0);
}

main().catch(e => { console.error("BACKFILL FAILED — nothing further was written:", e); process.exit(1); });
