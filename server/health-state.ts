/**
 * THE HEALTH HOLD — one owner for sick/recovery state (2026-08-21).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Illness was stored as three tokens inside a free-text column:
 *
 *     profileNotes = "… | sick_since:2026-08-16 | sick_until:2026-08-20 | paused_until:2026-08-20"
 *
 * and THIRTEEN separate files ran `/sick_until:(\d{4}-\d{2}-\d{2})/` over that string and then
 * decided for themselves what it meant. They did not agree. Measured on 21 August:
 *
 *   adaptive-targets.sickToday   sickUntil >= today                      string compare, SAST
 *   adaptive-training.ts:146     new Date(sickUntil) >= new Date(today)  Date compare, UTC midnight
 *   client-snapshot.ts:67        new Date(sickUntil) >= new Date(sastToday())
 *   one-action-command.ts:24     sickUntil T23:59:59+02:00 >= now        end of the final SAST day
 *   client-snapshot.ts:247       if (sickUntil)                          NO DATE CHECK AT ALL
 *
 * That last one is not a rounding difference. It told GPT "Client is SICK/resting until
 * 2026-08-20" every single turn, for as long as the token existed, with no reference to whether
 * the date had passed — and nothing in the product ever removed the token. Combined with a
 * recovery path that only fired on a fixed list of phrases, a client could be described to the
 * model as ill indefinitely. That is the shape of the 21 August failure on the founder's handset.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * This is a STATE owner: it parses, it derives, it writes. It is deliberately NOT a decision
 * owner — it returns no coaching verdict, no message, no instruction, and it must never grow one.
 * `chooseAction` remains the sole decision owner; this hands it a fact.
 *
 * NO NEW CLINICAL POLICY. Every threshold below is one that already existed somewhere in the
 * codebase; this file picks the existing rule that was already the most careful and applies it
 * everywhere, instead of letting each caller pick its own. Where the old rules genuinely
 * contradicted each other, the resolution is named at the rule.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE LIFECYCLE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 *   none ──entry──> sick ──(sick_until passes)──> recovering ──(+RECOVERY_TAIL)──> ended
 *     ^               │                               │                              │
 *     └───────────────┴──── recovery transition ──────┴──────────────────────────────┘
 *                          (declared, or the hold ages out)
 *
 * The `ended` phase is what the old code had no way to express. Expiry is DERIVED on read, not
 * swept by a job: a hold that has aged out reads as ended everywhere, immediately, without a cron
 * and without a migration. The tokens may linger in profileNotes — `clearHold` removes them when
 * a client declares recovery — but a lingering token can no longer make anyone believe the client
 * is ill, which was the actual defect.
 */

import { sastDayKey } from "./sast";

/**
 * THE READ IS PURE, AND STAYS PURE. `db` is imported lazily inside the writers only.
 *
 * A static `import { db }` here made every reader of this file — including the understanding
 * seed, which is a pure projection — transitively require DATABASE_URL at module load, and two
 * suites went red the moment the convergence landed. A state owner whose read cannot be called
 * without a database is a state owner nobody will call.
 */
const writer = async () => {
  const [{ db }, { users }, { eq }] = await Promise.all([
    import("./db"), import("../shared/schema"), import("drizzle-orm"),
  ]);
  return { db, users, eq };
};

/**
 * Days after `sick_until` during which the client counts as RECOVERING rather than well.
 *
 * Not a new number: adaptive-training.ts:147 and scheduler/shared.ts:891 both already used 3 days
 * for exactly this, independently and identically. Taking it here is convergence, not policy.
 */
export const RECOVERY_TAIL_DAYS = 3;

export type HealthPhase = "none" | "sick" | "recovering" | "ended";

export interface HealthState {
  phase: HealthPhase;
  /** True only while the hold is live. The one predicate callers should ask. */
  isSick: boolean;
  /** Inside the post-illness tail — well enough to train, not yet at full load. */
  isRecovering: boolean;
  /** Was the client ill during the day that just ended? What a morning brief needs. */
  wasSickYesterday: boolean;
  /**
   * The hold is over but the tokens are still on the row. Nothing should describe this client as
   * ill; the only correct use is to tidy the row up. `phase === "ended"` says the same thing.
   */
  isStale: boolean;
  /** ISO dates, exactly as stored. Present regardless of phase so a caller can explain itself. */
  sickSince?: string;
  sickUntil?: string;
  pausedUntil?: string;
  /** Whole days from sick_since to today. 0 when not on record. Prolonged-illness care reads this. */
  daysSick: number;
  /**
   * Why the proactive machine is held, if it is. "health" defers to the illness; "explicit" is a
   * pause the client asked for and outranks it. Null once the hold is over — an aged-out
   * paused_until holds nothing, which is the bug that silenced the 06:00 brief on 19 August.
   */
  pause: "explicit" | "health" | null;
}

const DATE = /(\d{4}-\d{2}-\d{2})/;
const token = (notes: string, key: string): string | undefined =>
  notes.match(new RegExp(`${key}:${DATE.source}`))?.[1];

const daysBetween = (fromISO: string, toISO: string): number =>
  Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86_400_000);

/**
 * THE ONE READ. Every caller that used to run its own regex calls this instead.
 *
 * `today` is injectable so the suites can drive the lifecycle across its transitions without
 * waiting three days; production never passes it.
 */
export function readHealthState(
  user: { profileNotes?: string | null } | null | undefined,
  today: string = sastDayKey(),
): HealthState {
  const notes = String(user?.profileNotes || "");
  const sickSince = token(notes, "sick_since");
  const sickUntil = token(notes, "sick_until");
  const pausedUntil = token(notes, "paused_until");

  // STRING COMPARISON ON ISO DATES, deliberately. `new Date("2026-08-20") >= new Date(sastToday())`
  // — the old comparison in three of the thirteen sites — parses both sides as UTC midnight, so
  // the final day of an illness ended at 02:00 SAST rather than at bedtime. ISO dates sort
  // lexicographically; comparing the strings keeps the whole final day inside the hold, which is
  // what one-action-command's `T23:59:59+02:00` was reaching for the long way round.
  const sick = !!sickUntil && sickUntil >= today;

  const daysPast = sickUntil && !sick ? daysBetween(sickUntil, today) : 0;
  const recovering = !sick && !!sickUntil && daysPast > 0 && daysPast <= RECOVERY_TAIL_DAYS;
  const ended = !!sickUntil && !sick && !recovering;

  // "Were they ill YESTERDAY" — the morning brief reports on the day that just closed. The rule
  // came from adaptive-targets.sickCoveredYesterday and is preserved exactly, including the
  // sick_since floor that stops a hold opened this morning from claiming yesterday.
  const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
  const wasSickYesterday = !!sickUntil
    && sickUntil >= yesterday
    && (!sickSince || sickSince <= yesterday);

  // A pause only holds while its date stands. An expired paused_until is not a pause — reading it
  // as one is what stopped the morning brief reaching a client whose illness was long over.
  const pauseLive = !!pausedUntil && pausedUntil >= today;
  const pause = !pauseLive ? null : (sickUntil ? "health" : "explicit");

  return {
    phase: !sickUntil ? "none" : sick ? "sick" : recovering ? "recovering" : "ended",
    isSick: sick,
    isRecovering: recovering,
    wasSickYesterday,
    isStale: ended,
    sickSince, sickUntil, pausedUntil,
    daysSick: sickSince ? Math.max(0, daysBetween(sickSince, today)) : 0,
    pause,
  };
}

/** The tokens, rendered. The only place the storage format is written. */
export function holdTokens(sickSince: string, sickUntil: string): string {
  return `sick_since:${sickSince} | sick_until:${sickUntil} | paused_until:${sickUntil}`;
}

/** Strip every health token from a notes string, leaving the rest of it intact. */
export function withoutHoldTokens(notes: string | null | undefined): string {
  return String(notes || "")
    .replace(/\s*\|?\s*(?:paused_until|sick_until|sick_since):\d{4}-\d{2}-\d{2}/g, "")
    .trim();
}

/**
 * ENTRY. Opens or extends a hold. `sick_since` is set once and preserved across every repeat
 * mention, so prolonged illness stays visible.
 */
export async function openHold(
  user: { id: string; profileNotes?: string | null }, days: number, today: string = sastDayKey(),
): Promise<{ sickSince: string; sickUntil: string; daysSick: number }> {
  const notes = String(user.profileNotes || "");
  const sickSince = token(notes, "sick_since") || today;
  const sickUntil = new Date(Date.parse(today) + days * 86_400_000).toISOString().slice(0, 10);
  const rest = withoutHoldTokens(notes);
  const { db, users, eq } = await writer();
  await db.update(users)
    .set({ profileNotes: `${rest ? rest + " | " : ""}${holdTokens(sickSince, sickUntil)}` })
    .where(eq(users.id, user.id));
  return { sickSince, sickUntil, daysSick: Math.max(0, daysBetween(sickSince, today)) };
}

/** RECOVERY TRANSITION. Removes the hold entirely. Safe to call when there is none. */
export async function clearHold(user: { id: string; profileNotes?: string | null }): Promise<void> {
  const cleaned = withoutHoldTokens(user.profileNotes);
  const { db, users, eq } = await writer();
  await db.update(users)
    .set({ profileNotes: cleaned || null })
    .where(eq(users.id, user.id));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE EXPLICIT PAUSE — same tokens, different lifecycle, same owner.
//
// `paused_until` carries two unrelated meanings: a HEALTH hold (written beside sick_until by
// openHold) and a pause the client asked for — opt-out, a price pause, a holiday. Those were
// written and cleared by hand in four places in lifecycle.ts, each with its own
// replace-or-append dance, which is how one of them ended up appending a second paused_until
// beside the first. The tokens have one writer now; `readHealthState().pause` tells the two
// apart by whether a sick_until stands beside it.
// ════════════════════════════════════════════════════════════════════════════════════════════

/** Set (or move) an explicit pause to `days` from today. Leaves any health tokens untouched. */
export async function setExplicitPause(
  user: { id?: string; phoneNumber?: string; profileNotes?: string | null },
  days: number,
  today: string = sastDayKey(),
): Promise<string> {
  const until = new Date(Date.parse(today) + days * 86_400_000).toISOString().slice(0, 10);
  const notes = String(user.profileNotes || "");
  const rest = notes.replace(/\s*\|?\s*paused_until:\d{4}-\d{2}-\d{2}/g, "").trim();
  const updated = `${rest ? rest + " | " : ""}paused_until:${until}`;
  const { db, users, eq } = await writer();
  await db.update(users).set({ profileNotes: updated })
    .where(user.id ? eq(users.id, user.id) : eq(users.phoneNumber, String(user.phoneNumber)));
  return until;
}

/** Lift a pause. Returns whether there was one to lift. */
export async function clearPause(
  user: { id?: string; phoneNumber?: string; profileNotes?: string | null },
): Promise<boolean> {
  const notes = String(user.profileNotes || "");
  if (!/paused_until:\d{4}-\d{2}-\d{2}/.test(notes)) return false;
  const cleaned = notes.replace(/\s*\|?\s*paused_until:\d{4}-\d{2}-\d{2}/g, "").trim();
  const { db, users, eq } = await writer();
  await db.update(users).set({ profileNotes: cleaned || null })
    .where(user.id ? eq(users.id, user.id) : eq(users.phoneNumber, String(user.phoneNumber)));
  return true;
}
