/**
 * SIGN-UP SOURCE CAPTURE (db-aware wrapper around the pure parser in signup-source.ts).
 * Kept out of signup-source.ts so that module stays DB-free and unit-testable.
 */

import { db } from "./db";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";
import { parseSignupSource } from "./signup-source";

// Persist the acquisition source from a client's first message, once. Returns the captured
// tag (and sets it on the in-memory user) or null when there's nothing to capture.
export async function captureSignupSource(user: any, phone: string, message: string): Promise<string | null> {
  if (user.signupSource || !message) return null;
  const src = parseSignupSource(message);
  if (!src) return null;
  await db.update(users).set({ signupSource: src }).where(eq(users.phoneNumber, phone)).catch(() => {});
  user.signupSource = src;
  return src;
}

/**
 * A FRIEND'S REFERRAL (C8). The share link opens WhatsApp with "Hi, I was referred by ABC1234"; nothing read it,
 * so referred_by was never set and the inviter's promised free month (payments.ts) never came. Read once, from a
 * client who has not finished signing up, for a code that exists and is not their own.
 */
export async function captureReferral(user: any, phone: string, message: string): Promise<boolean> {
  if (user.referredBy || user.onboardingState === "COMPLETE" || !message) return false;
  const code = message.match(/\breferred by\s+([A-Za-z0-9]{6,7})\b/i)?.[1]?.toUpperCase();
  if (!code) return false;
  const [inviter] = await db.select({ id: users.id }).from(users).where(eq(users.referralCode, code)).limit(1);
  if (!inviter || inviter.id === user.id) return false;
  await db.update(users).set({ referredBy: inviter.id }).where(eq(users.phoneNumber, phone)).catch(() => {});
  user.referredBy = inviter.id;
  return true;
}
