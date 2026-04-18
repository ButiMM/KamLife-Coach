// A/B testing engine — assignment, delivery tracking, conversion attribution.
//
// Design principles:
//  1. Deterministic assignment: same user + same experiment always gets the same
//     variant. We use a simple hash so even if the DB record is missing (race),
//     the variant will be re-computed consistently.
//  2. Sticky via DB: first call to getOrAssignVariant writes to ab_assignments.
//     All subsequent calls return the stored record without hashing again.
//  3. Non-blocking: errors never throw into the caller — all functions return
//     null / false on failure so the scheduler / message handler keeps going.
//  4. Attribution window: a user reply within ATTRIBUTION_WINDOW_MS of the
//     last delivery for an experiment is counted as a conversion.

import { db } from "./db";
import { abExperiments, abAssignments } from "../shared/schema";
import { eq, and, isNull, gte, desc } from "drizzle-orm";

export const ATTRIBUTION_WINDOW_MS = 24 * 60 * 60_000; // 24 hours

// ── Deterministic variant hash (no crypto needed — just needs stable distribution) ──
function hashVariant(userId: string, experimentId: number): "A" | "B" {
  // Simple string fold — avoids an import, good enough for 50/50 splits.
  let h = 0;
  const seed = `${userId}:${experimentId}`;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0; // unsigned 32-bit
  }
  return (h % 2 === 0) ? "A" : "B";
}

// ── Get or create a variant assignment for a user × experiment ──
// Returns the variant ("A" | "B") or null on error.
export async function getOrAssignVariant(
  userId: string,
  experimentId: number,
): Promise<{ assignmentId: number; variant: "A" | "B" } | null> {
  try {
    // Prefer existing record — don't re-assign mid-experiment.
    const existing = await db
      .select({ id: abAssignments.id, variant: abAssignments.variant })
      .from(abAssignments)
      .where(and(eq(abAssignments.userId, userId), eq(abAssignments.experimentId, experimentId)))
      .limit(1);
    if (existing.length) {
      return { assignmentId: existing[0].id, variant: existing[0].variant as "A" | "B" };
    }

    const variant = hashVariant(userId, experimentId);
    const [inserted] = await db
      .insert(abAssignments)
      .values({ experimentId, userId, variant })
      .returning({ id: abAssignments.id });
    if (!inserted) return null;
    return { assignmentId: inserted.id, variant };
  } catch (err) {
    console.warn(`[AB] getOrAssignVariant error (user=${userId.slice(0,8)} exp=${experimentId}):`, err);
    return null;
  }
}

// ── Record that a message was delivered to a user ──
export async function recordDelivery(assignmentId: number): Promise<boolean> {
  try {
    await db
      .update(abAssignments)
      .set({ delivered: true, deliveredAt: new Date() })
      .where(eq(abAssignments.id, assignmentId));
    return true;
  } catch (err) {
    console.warn(`[AB] recordDelivery error (assignment=${assignmentId}):`, err);
    return false;
  }
}

// ── Record that a user responded (conversion) ──
// Looks up the most recent delivered-but-not-responded assignment for this user
// within the attribution window. If found, marks it responded.
// action: short string describing what they did, e.g. "food_logged", "replied", "workout_done"
export async function recordConversion(userId: string, action: string): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - ATTRIBUTION_WINDOW_MS);
    const pending = await db
      .select({ id: abAssignments.id })
      .from(abAssignments)
      .where(
        and(
          eq(abAssignments.userId, userId),
          eq(abAssignments.delivered, true),
          eq(abAssignments.responded, false),
          gte(abAssignments.deliveredAt, cutoff),
        ),
      )
      .orderBy(desc(abAssignments.deliveredAt))
      .limit(1);

    if (!pending.length) return false;

    await db
      .update(abAssignments)
      .set({ responded: true, respondedAt: new Date(), convertedAction: action })
      .where(eq(abAssignments.id, pending[0].id));
    return true;
  } catch (err) {
    console.warn(`[AB] recordConversion error (user=${userId.slice(0,8)}):`, err);
    return false;
  }
}

// ── Get the active experiment(s) for a given message type ──
// Used by the scheduler to check whether to run a variant before sending.
export async function getActiveExperiment(
  messageType: string,
): Promise<typeof abExperiments.$inferSelect | null> {
  try {
    const [exp] = await db
      .select()
      .from(abExperiments)
      .where(and(eq(abExperiments.status, "active"), eq(abExperiments.messageType, messageType)))
      .limit(1);
    return exp || null;
  } catch (err) {
    console.warn(`[AB] getActiveExperiment error (type=${messageType}):`, err);
    return null;
  }
}

// ── Select message template for a user, respecting A/B ──
// Returns the variant template string if an active experiment exists for the
// messageType, otherwise returns the fallback template unchanged.
// Also fires delivery tracking and returns assignment metadata for the caller.
export async function selectVariantMessage(
  userId: string,
  messageType: string,
  fallbackTemplate: string,
): Promise<{ text: string; assignmentId: number | null; variant: "A" | "B" | null }> {
  const exp = await getActiveExperiment(messageType);
  if (!exp) return { text: fallbackTemplate, assignmentId: null, variant: null };

  const assignment = await getOrAssignVariant(userId, exp.id);
  if (!assignment) return { text: fallbackTemplate, assignmentId: null, variant: null };

  const text = assignment.variant === "A" ? exp.variantA : exp.variantB;
  return { text, assignmentId: assignment.assignmentId, variant: assignment.variant };
}
