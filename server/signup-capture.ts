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
