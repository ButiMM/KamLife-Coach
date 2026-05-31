// Backfill stepsTarget for existing users using the BMI/age/experience-aware
// calculateStepsTarget(). Clients onboarded before the eased-in step logic shipped
// still carry a flat 10,000 goal — this recomputes a humane starting goal for them
// so a heavier, older, or never-trained body is not thrown straight into 10k.
//
// Run on Railway (needs DATABASE_URL):  npm run backfill:steps
// Idempotent: recomputing for an already-correct user yields the same value, so it
// is safe to run more than once.

import { db } from "../server/db";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";
import { calculateStepsTarget } from "../server/targets";

async function main() {
  const all = await db.select({
    id: users.id,
    currentWeight: users.currentWeight,
    age: users.age,
    heightCm: users.heightCm,
    trainingExperience: users.trainingExperience,
    stepsTarget: users.stepsTarget,
  }).from(users);

  let updated = 0;
  let skippedNoData = 0;
  let skippedSame = 0;

  for (const u of all) {
    const weight = parseFloat((u.currentWeight as string) || "0");
    // Without weight/age/height we cannot compute a meaningful target — leave as-is.
    if (!weight || !u.age || !u.heightCm) { skippedNoData++; continue; }

    const target = calculateStepsTarget(weight, u.age, u.heightCm, u.trainingExperience || "beginner");
    if (u.stepsTarget === target) { skippedSame++; continue; }

    await db.update(users).set({ stepsTarget: target }).where(eq(users.id, u.id));
    updated++;
  }

  console.log(
    `backfill-step-targets: ${updated} updated, ${skippedSame} already correct, ` +
    `${skippedNoData} skipped (missing weight/age/height) — of ${all.length} total users`,
  );
  process.exit(0);
}

main().catch((e) => { console.error("backfill-step-targets failed:", e); process.exit(1); });
