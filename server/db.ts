import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { eq } from "drizzle-orm";

const { Pool } = pg;

// ── STUB MODE — offline routing tests only (KAMLIFE_DB_STUB=1) ───────────────
// Never set in production. Returns a chainable thenable proxy: any drizzle
// query resolves to [] — except selects on the users table, which resolve to
// [globalThis.__KAMLIFE_STUB_USER] so the message pipeline sees a real client.
// Writes to the users table PERSIST into that global (update().set() and
// insert().values() merge into it), so multi-turn offline tests — the
// onboarding E2E walk — see real state transitions. Suites that need isolation
// reassign __KAMLIFE_STUB_USER per case (routing-audit already does).
const STUB = process.env.KAMLIFE_DB_STUB === "1";

/**
 * THE STUB COULD NOT EXPRESS TIME (2026-08-25, issue #63).
 *
 * `.where(...)` used to `return chain(state)` — it discarded the condition entirely, so seeded
 * rows came back for EVERY query on that table whatever the date window. A handler asking "what
 * did they log today" and a handler asking "what did they log this month" received identical
 * answers, which means no offline suite could test day attribution, retro-day resolution, or
 * multi-day catch-up. The one product requirement that is entirely about time had a test double
 * that had no concept of it.
 *
 * That is not a missing fixture. It is a substrate that cannot represent the customer scenario,
 * and it is why a reproduction of "logged from yesterday" had to be thrown away as an artifact:
 * the harness handed the handler yesterday's row because it could not filter.
 *
 * This walks drizzle's condition tree and evaluates the comparisons a ledger query actually uses.
 * It is DELIBERATELY PARTIAL. Anything it cannot interpret — a subquery, a function call, an
 * operator not listed — returns `undefined` and the row is KEPT, so an unrecognised condition
 * behaves exactly as before rather than silently emptying a result set. A stub that quietly
 * dropped rows it did not understand would be a worse lie than the one being fixed.
 */
type Cmp = ">=" | "<=" | ">" | "<" | "=" | "<>";
const CMP: Record<Cmp, (a: any, b: any) => boolean> = {
  ">=": (a, b) => a >= b, "<=": (a, b) => a <= b, ">": (a, b) => a > b,
  "<": (a, b) => a < b, "=": (a, b) => a === b, "<>": (a, b) => a !== b,
};

/** Values arrive as Date, string or number; compare on one scale or `>=` is lexicographic. */
function comparable(v: any): any {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t) && /\d{4}-\d{2}-\d{2}/.test(v)) return t;
  }
  return v;
}

/**
 * Returns true (keep), false (drop), or undefined (not interpretable — keep).
 * `undefined` is distinct from `true` so an AND can tell "passed" from "unknown".
 */
function evalCondition(cond: any, row: Record<string, any>): boolean | undefined {
  if (!cond || typeof cond !== "object") return undefined;
  const chunks: any[] = cond.queryChunks;
  if (!Array.isArray(chunks)) return undefined;

  // A composite (and/or) is a chunk list whose own chunks are SQL nodes. Recurse, then combine on
  // the separator drizzle wrote between them.
  const nested = chunks.filter(c => c && typeof c === "object" && Array.isArray(c.queryChunks));
  if (nested.length > 1) {
    const joiner = chunks.map(c => (typeof c?.value === "string" ? c.value : "")).join(" ").toLowerCase();
    const results = nested.map(n => evalCondition(n, row));
    if (joiner.includes(" or ")) {
      if (results.some(r => r === true)) return true;
      return results.every(r => r === false) ? false : undefined;
    }
    // AND: any definite false drops the row; otherwise unknown unless all definitely true.
    if (results.some(r => r === false)) return false;
    return results.every(r => r === true) ? true : undefined;
  }
  if (nested.length === 1) return evalCondition(nested[0], row);

  // A leaf: [ StringChunk, Column, StringChunk(" >= "), Param, StringChunk ].
  // StringChunk.value is a string ARRAY, not a string — reading it as a string silently found no
  // operator and every row was kept, which is the same "quietly does nothing" failure this whole
  // change exists to remove.
  const asText = (c: any): string => {
    if (typeof c === "string") return c;
    if (Array.isArray(c?.value)) return c.value.join(" ");
    if (typeof c?.value === "string") return c.value;
    return "";
  };
  // A StringChunk is identified by SHAPE (its value is a string array), never by whether it
  // happens to render non-empty. The leading chunk is `[""]`, so testing "did this produce text"
  // let the empty separator be read as the parameter and every comparison silently became
  // `undefined` — keep-everything, exactly the behaviour being replaced.
  let col: any, op: Cmp | undefined, param: any, sawParam = false;
  for (const c of chunks) {
    if (typeof c === "string" || Array.isArray(c?.value)) {
      const m = asText(c).match(/(>=|<=|<>|!=|=|>|<)/);
      if (m && !op) op = (m[1] === "!=" ? "<>" : m[1]) as Cmp;
      continue;
    }
    if (c && typeof c === "object" && typeof c.name === "string" && c.name && !col) { col = c; continue; }
    if (c && typeof c === "object" && "value" in c && !sawParam) { param = c.value; sawParam = true; }
  }
  if (!col || !op || !sawParam) return undefined;

  // Drizzle columns carry the DB name; seeded rows are written in camelCase, so accept either.
  const camel = String(col.name).replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
  const key = camel in row ? camel : (col.name in row ? col.name : undefined);
  if (key === undefined) return undefined;   // column not seeded — cannot judge, keep

  const fn = CMP[op];
  return fn ? fn(comparable(row[key]), comparable(param)) : undefined;
}

function makeStubDb(): any {
  function chain(state: { table?: any; conds?: any[] }): any {
    const fn: any = () => {};
    return new Proxy(fn, {
      get(_t, prop: string | symbol) {
        if (prop === "then" || prop === "catch" || prop === "finally") {
          const stubUser = (globalThis as any).__KAMLIFE_STUB_USER;
          // SEEDED LEDGER ROWS (2026-08-22). Same opt-in shape as __KAMLIFE_STUB_USER, one table
          // deeper: a suite that needs the stub to hold a real workout/step/meal history sets
          // globalThis.__KAMLIFE_STUB_ROWS to a Map keyed by the drizzle table. Unset — which is
          // every existing caller — nothing changes and non-users selects still resolve to [].
          // Needed because "the log says 1, the model said 4" cannot be proved against a log that
          // can only ever say 0.
          const seeded = (globalThis as any).__KAMLIFE_STUB_ROWS as Map<any, any[]> | undefined;
          const all = seeded?.get(state.table)
            ?? (state.table === (schema as any).users && stubUser ? [{ ...stubUser }] : []);
          // THE WHERE IS APPLIED (2026-08-25). Only to SEEDED rows: the users row is the pipeline's
          // own client and is looked up by phone/id in ways the evaluator has no reason to judge,
          // so narrowing it would break every existing suite for no gain.
          const rows = (seeded?.get(state.table) && state.conds?.length)
            ? all.filter(r => state.conds!.every(c => evalCondition(c, r) !== false))
            : all;
          // `.catch()` USED TO DISCARD THE SEED (fixed 2026-08-25). It returned
          // `Promise.resolve([]).catch(h)` — a resolved promise of the EMPTY array, whatever the
          // suite had seeded. Every query in loadProactiveState ends in `.catch(() => [])`, so a
          // seeded ledger reached none of them: the state came back all-null and any test built on
          // it graded the come_back rung instead of the one it meant to. Same class of defect as
          // the `.catch()` on the drizzle chain that silently disabled the outbound floor.
          if (prop === "catch") return (h: any) => Promise.resolve(rows).catch(h);
          if (prop === "finally") return (h: any) => Promise.resolve(rows).finally(h);
          return (res: any, rej: any) => Promise.resolve(rows).then(res, rej);
        }
        return (...args: any[]) => {
          if (prop === "from" || prop === "into") return chain({ ...state, table: args[0] });
          // Conditions accumulate: drizzle allows .where() once, but a builder may re-wrap.
          if (prop === "where" && args[0]) return chain({ ...state, conds: [...(state.conds || []), args[0]] });
          if ((prop === "set" || prop === "values") && state.table === (schema as any).users
              && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
            const stubUser = (globalThis as any).__KAMLIFE_STUB_USER;
            if (stubUser) Object.assign(stubUser, args[0]);
          }
          // WRITES ARE OBSERVABLE (2026-08-25). A suite that needs to grade what a code path wrote
          // — as opposed to what it returned — sets globalThis.__KAMLIFE_STUB_WRITES to an array
          // and reads it back. The proactive door captures its final outbound body through
          // shadowDoor's insert, so this is how "what would the client have read" is graded end to
          // end without patching Twilio or adding a seam to production code. Unset: no-op.
          if (prop === "values" && Array.isArray((globalThis as any).__KAMLIFE_STUB_WRITES)) {
            (globalThis as any).__KAMLIFE_STUB_WRITES.push({ table: state.table, values: args[0] });
          }
          // WRITES CAN BE READ BACK (2026-08-26, issue #63). Reads served the seeded rows and
          // nothing else, so a row this turn INSERTED was invisible to every later read in the
          // same turn. That makes "the coach decides on state that includes what just happened"
          // untestable — the exact ordering the coaching turn depends on, where asking before the
          // write tells a client who just logged 8 000 steps to go for a walk. Opt-in via
          // __KAMLIFE_STUB_REFLECT_WRITES so the suites that do not ask for it see no change.
          if (prop === "values" && (globalThis as any).__KAMLIFE_STUB_REFLECT_WRITES && state.table) {
            const seed = (globalThis as any).__KAMLIFE_STUB_ROWS as Map<any, any[]> | undefined;
            if (seed) {
              const held = seed.get(state.table) || [];
              seed.set(state.table, [...held, { id: `stubw${held.length + 1}`, loggedAt: new Date(), ...args[0] }]);
            }
          }
          // UPDATES ARE OBSERVABLE TOO (2026-08-26, issue #63) — and separately, on purpose.
          // __KAMLIFE_STUB_WRITES records inserts only, so no suite could see a row being CHANGED:
          // "an explicit correction overwrites the day's step count downward" was ungradeable, and
          // an upsert that took its update branch looked identical to one that did nothing. This
          // is a second channel rather than more entries in the first because `db.update(users)
          // .set({ lastActiveAt })` runs on nearly every turn — folding those in would add a row
          // to every write assertion in every suite. Opt in by assigning an array; unset: no-op.
          if (prop === "set" && Array.isArray((globalThis as any).__KAMLIFE_STUB_UPDATES)) {
            (globalThis as any).__KAMLIFE_STUB_UPDATES.push({ table: state.table, set: args[0] });
          }
          return chain(state);
        };
      },
      apply: () => chain(state),
    });
  }
  return new Proxy({}, {
    get(_t, prop: string | symbol) {
      if (prop === "transaction") return async (cb: any) => cb(makeStubDb());
      if (prop === "execute") return async () => ({ rows: [] });
      return (...args: any[]) => chain({ table: args[0] });
    },
  });
}

if (!STUB && !process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function makeRealPool() {
  // Railway postgres allows 100 connections; default 25 for the app leaves headroom
  // for admin/migrations and a second replica. Tunable as the base grows (DB_POOL_MAX).
  const max = Math.max(5, Number(process.env.DB_POOL_MAX) || 25);
  // Kill a pathological query before it pins a connection and cascades into pool
  // exhaustion (set 0 to disable).
  const stmtTimeout = process.env.PG_STATEMENT_TIMEOUT_MS !== undefined
    ? Number(process.env.PG_STATEMENT_TIMEOUT_MS)
    : 30_000;
  const p = new Pool({
    connectionString: process.env.DATABASE_URL,
    max,
    idleTimeoutMillis: 30_000,       // close idle connections after 30s
    connectionTimeoutMillis: 5_000,  // fail fast under load rather than queueing indefinitely
    keepAlive: true,                 // TCP keepalive — stops the proxy silently dropping idle sockets
  });
  // Apply statement_timeout per connection via SET (fail-safe: a failed SET never
  // blocks the connection, unlike a startup `options` param that a pooler can reject).
  if (stmtTimeout > 0) {
    p.on("connect", (client) => {
      client.query(`SET statement_timeout TO ${stmtTimeout}`).catch(() => {});
    });
  }
  // CRITICAL: without this, an error on an idle client (DB restart, network blip)
  // emits 'error' on the pool and crashes the whole Node process. At scale this
  // happens routinely during DB maintenance — swallow it and let the pool recover.
  p.on("error", (err) => {
    console.error("[DB] Idle client error (pool will recover):", err.message);
  });
  return p;
}
function makeRealDb(p: ReturnType<typeof makeRealPool>) {
  return drizzle(p, { schema });
}

const stubPool = {
  // SEEDED RAW ROWS (2026-08-25). The drizzle stub grew __KAMLIFE_STUB_ROWS for the same reason
  // this needs one: the held-constraint reader goes through pool.query, not drizzle, so "the
  // client said at 08:00 that they are not training today" could not be expressed offline — and
  // an invariant about held state cannot be graded against a history that is always empty.
  // Opt-in: a function of (sql, params) returning rows, or a flat array. Unset — which is every
  // existing caller — behaves exactly as before.
  query: async (text?: any, params?: any) => {
    const seed = (globalThis as any).__KAMLIFE_STUB_PGROWS;
    if (typeof seed === "function") return { rows: seed(text, params) ?? [] };
    if (Array.isArray(seed)) return { rows: seed };
    return { rows: [] };
  },
  connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  end: async () => {},
  on() {},
};

// Cast stubs to the real types so type inference across the codebase is unchanged.
export const pool = (STUB ? (stubPool as unknown) : makeRealPool()) as ReturnType<typeof makeRealPool>;
export const db = (STUB ? (makeStubDb() as unknown) : makeRealDb(pool)) as ReturnType<typeof makeRealDb>;

/**
 * RECORDED NORMALIZATION — the front door, replayed offline (2026-08-25, issue #63 item 1.1).
 *
 * Production runs the normalizer on every message before any handler sees it. Eight deterministic
 * harnesses set NORMALIZER=off because it calls a live model, so the transformation that reaches
 * production FIRST has never been exercised by an offline suite — "351/355 green" describes a path
 * production does not run for messy input. The classifier's regex fast paths cannot stand in for
 * it: they classify and never return a `canonical`, and the rewrite is the half that can destroy
 * information before the capability built for it is reached.
 *
 * So the real model is recorded once (script/record-normalizer.ts) and replayed here — production's
 * actual rewrite, with no key and no bill per run.
 *
 * IT LIVES HERE, beside the DB stub, because this file is where offline test doubles belong. A
 * seam scattered into gpt.ts is a test concern sitting in the middle of a production code path,
 * and the next reader has to work out whether it can fire in production. It cannot: it returns
 * undefined unless a suite has explicitly installed fixtures.
 *
 * STRICT IS THE IMPORTANT HALF. Under replay, an input that was never recorded THROWS. Falling
 * through would reach the offline model shim, return OTHER with no canonical, and the test would
 * pass having exercised nothing — the vacuous-pass trap that #63 found three times in one day.
 */
export function recordedIntent<T>(message: string): T | undefined {
  const fixtures = (globalThis as any).__KAMLIFE_INTENT_FIXTURES as Record<string, T> | undefined;
  if (!fixtures) return undefined;
  const hit = fixtures[message.trim().toLowerCase()];
  if (hit) return hit;
  if (process.env.NORMALIZER_FIXTURES_STRICT === "1") {
    throw new Error(`[NORMALIZER_FIXTURES] no recorded normalization for ${JSON.stringify(message)}`
      + ` — re-record with script/record-normalizer.ts`);
  }
  return undefined;
}


/**
 * Load the caller's durable profile, creating the safe day-zero record exactly once.
 *
 * This is deliberately outside the message router: profile creation is persistence
 * setup, not a routing claimant. The unique-phone recovery preserves the prior
 * concurrent-first-message behaviour.
 */
export async function getOrCreateUser(phone: string): Promise<any> {
  const existing = await db.select().from(schema.users).where(eq(schema.users.phoneNumber, phone)).limit(1);
  if (existing.length > 0) {
    await db.update(schema.users).set({ lastActiveAt: new Date() }).where(eq(schema.users.phoneNumber, phone));
    return existing[0];
  }
  try {
    const newUsers = await db.insert(schema.users).values({
      phoneNumber: phone,
      subscriptionStatus: "inactive",
      onboardingState: "START",
      programmePhase: 1,
      programmeWeek: 1,
      programmeDayInWeek: 1,
      trainingMode: "home",
      stepsTarget: 8500,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    }).returning();
    return newUsers[0];
  } catch (err: any) {
    if (err.code === "23505") {
      const fallback = await db.select().from(schema.users).where(eq(schema.users.phoneNumber, phone)).limit(1);
      if (fallback.length > 0) return fallback[0];
    }
    throw err;
  }
}
