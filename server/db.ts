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
        if (prop === "then") {
          const stubUser = (globalThis as any).__KAMLIFE_STUB_USER;
          const rows = state.table === (schema as any).users && stubUser ? [{ ...stubUser }] : [];
          return (res: any, rej: any) => Promise.resolve(rows).then(res, rej);
        }
        if (prop === "catch") return (h: any) => Promise.resolve([]).catch(h);
        if (prop === "finally") return (h: any) => Promise.resolve([]).finally(h);
        return (...args: any[]) => {
          if (prop === "from" || prop === "into") return chain({ table: args[0] });
          if ((prop === "set" || prop === "values") && state.table === (schema as any).users
              && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
            const stubUser = (globalThis as any).__KAMLIFE_STUB_USER;
            if (stubUser) Object.assign(stubUser, args[0]);
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
  query: async () => ({ rows: [] }),
  connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  end: async () => {},
  on() {},
};

// Cast stubs to the real types so type inference across the codebase is unchanged.
export const pool = (STUB ? (stubPool as unknown) : makeRealPool()) as ReturnType<typeof makeRealPool>;
export const db = (STUB ? (makeStubDb() as unknown) : makeRealDb(pool)) as ReturnType<typeof makeRealDb>;
