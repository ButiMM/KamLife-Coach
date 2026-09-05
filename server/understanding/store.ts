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

import { eq, lte } from "drizzle-orm";
import { db } from "../db";
import { clientUnderstanding } from "../../shared/schema";
import {
  type UnderstandingState,
  coerceUnderstanding,
  persistableUnderstanding,
  decayObservations,
} from "./state";

export async function loadUnderstanding(userId: string, seed: UnderstandingState): Promise<UnderstandingState> {
  try {
    const rows = await db.select().from(clientUnderstanding).where(eq(clientUnderstanding.userId, userId)).limit(1);
    const row = rows[0];
    if (!row) return seed;
    const stored = coerceUnderstanding(
      { profile: row.profile, observations: row.observations },
      seed.profile.name,
    );
    // updatedAt answers ONE question and it is the right one for it: how stale is the understanding
    // we stored? That is a persistence fact and this is the persistence layer. It must NOT also
    // decide re-entry — the client's contact clock is users.lastActiveAt, and seedUnderstanding
    // now sources that from the canonical resolver. One variable, two questions, was the defect.
    const ageHours = row.updatedAt ? (Date.now() - new Date(row.updatedAt).getTime()) / 3_600_000 : 0;
    stored.observations = decayObservations(stored.observations, ageHours);
    return {
      profile: {
        name: seed.profile.name || stored.profile.name,
        lifeStory: stored.profile.lifeStory || seed.profile.lifeStory,
        // Factual slots are rebuilt from the committed users projection every turn. Stored
        // understanding is model-derived narrative/observation and may never overrule them.
        keyFacts: seed.profile.keyFacts,
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

export async function saveUnderstanding(userId: string, state: UnderstandingState, sourceRevision = 0): Promise<void> {
  try {
    const durable = persistableUnderstanding(state);
    await db.insert(clientUnderstanding)
      .values({ userId, profile: durable.profile as any, observations: durable.observations as any, sourceRevision, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: clientUnderstanding.userId,
        set: { profile: durable.profile as any, observations: durable.observations as any, sourceRevision, updatedAt: new Date() },
        // A slow earlier turn may finish its model call after a newer fact commit. Reject it rather
        // than allowing its whole JSON blob to erase the newer turn's understanding.
        setWhere: lte(clientUnderstanding.sourceRevision, sourceRevision),
      });
  } catch (e) {
    console.warn("[UNDERSTANDING_STORE] save failed (non-fatal):", (e as any)?.message || e);
  }
}
