/**
 * The UnderstandingState store (blueprint Days 11-20): durable read/write per client.
 *
 * loadUnderstanding merges the PERSISTED durable subset (profile + observations) onto a
 * freshly-seeded state (which carries this-turn volatile fields + DB-derived stats). So
 * every turn starts from: what we durably know about the person + where they are right now.
 *
 * saveUnderstanding writes back ONLY the durable subset, through the trust gate — the
 * volatile mood/topic and the DB stats are never persisted (they'd be stale or a model
 * guess). This is the discipline the reviews demanded: persist only what you can trust.
 *
 * Fail-open everywhere: a store miss/error must never break a reply — we fall back to the
 * seed. The table (client_understanding) is created by `npm run db:push`.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { clientUnderstanding } from "../../shared/schema";
import {
  type UnderstandingState,
  coerceUnderstanding,
  persistableUnderstanding,
  decayObservations,
} from "./state";

/**
 * Load a client's understanding: the durable persisted subset merged onto `seed`
 * (which already holds this-turn health/prefs + snapshot-derived stats). If nothing is
 * stored yet, the seed is returned as-is.
 */
export async function loadUnderstanding(userId: string, seed: UnderstandingState): Promise<UnderstandingState> {
  try {
    const rows = await db.select().from(clientUnderstanding).where(eq(clientUnderstanding.userId, userId)).limit(1);
    const row = rows[0];
    if (!row) return seed;
    // Coerce the stored JSON through the trust gate, then overlay the DURABLE fields onto
    // the seed. Seed keeps: current (this-turn), stats (DB truth). Stored wins for: the
    // accumulated profile + observations.
    const stored = coerceUnderstanding(
      { profile: row.profile, observations: row.observations },
      seed.profile.name,
    );
    // Law 5 — decay stale inferences. If it's been a while since we last read this client,
    // their frustration/confidence/readiness reads have expired; pull them back to neutral
    // so the coach never greets a returning client stuck on a weeks-old mood.
    const ageHours = row.updatedAt ? (Date.now() - new Date(row.updatedAt).getTime()) / 3_600_000 : 0;
    stored.observations = decayObservations(stored.observations, ageHours);
    return {
      profile: {
        // name/prefs from the seed (live source of truth); narrative/facts from storage.
        name: seed.profile.name || stored.profile.name,
        lifeStory: stored.profile.lifeStory || seed.profile.lifeStory,
        keyFacts: stored.profile.keyFacts.length ? stored.profile.keyFacts : seed.profile.keyFacts,
        preferences: seed.profile.preferences,
      },
      observations: stored.observations,
      current: seed.current,
      stats: seed.stats,
      updatedAt: seed.updatedAt,
    };
  } catch (e) {
    console.warn("[UNDERSTANDING_STORE] load failed (using seed):", (e as any)?.message || e);
    return seed;
  }
}

/** Upsert ONLY the durable subset (profile + observations). Fire-and-forget-safe. */
export async function saveUnderstanding(userId: string, state: UnderstandingState): Promise<void> {
  try {
    const durable = persistableUnderstanding(state);
    await db.insert(clientUnderstanding)
      .values({ userId, profile: durable.profile as any, observations: durable.observations as any, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: clientUnderstanding.userId,
        set: { profile: durable.profile as any, observations: durable.observations as any, updatedAt: new Date() },
      });
  } catch (e) {
    console.warn("[UNDERSTANDING_STORE] save failed (non-fatal):", (e as any)?.message || e);
  }
}
