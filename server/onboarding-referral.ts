/**
 * Referral-code generation for onboarding completion. Extracted from
 * onboarding.ts (file-size budget). A DB blip here must never abort
 * onboarding — the code is a nice-to-have; skip it and let the welcome go out.
 */
import { db } from "./db";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";

export async function generateReferralCode(name: string | null | undefined): Promise<string | undefined> {
  const namePrefix = (name || "KAM").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "K");
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${namePrefix}${Math.floor(1000 + Math.random() * 9000)}`;
    try {
      const existing = await db.select({ id: users.id }).from(users).where(eq(users.referralCode, candidate)).limit(1);
      if (existing.length === 0) return candidate;
    } catch (e) {
      console.warn("[ONBOARDING] referral code check failed, skipping:", e);
      return undefined;
    }
  }
  return undefined;
}
