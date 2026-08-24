import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

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

function makeStubDb(): any {
  function chain(state: { table?: any }): any {
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
          const rows = seeded?.get(state.table)
            ?? (state.table === (schema as any).users && stubUser ? [{ ...stubUser }] : []);
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
          if (prop === "from" || prop === "into") return chain({ table: args[0] });
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
