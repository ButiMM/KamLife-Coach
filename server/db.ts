import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

// ── STUB MODE — offline routing tests only (KAMLIFE_DB_STUB=1) ───────────────
// Never set in production. Returns a chainable thenable proxy: any drizzle
// query resolves to [] — except selects on the users table, which resolve to
// [globalThis.__KAMLIFE_STUB_USER] so the message pipeline sees a real client.
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
        return (...args: any[]) =>
          (prop === "from" || prop === "into") ? chain({ table: args[0] }) : chain(state);
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
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 50,                    // Railway postgres allows 100; 50 for app, leaving headroom for scheduler/admin/migrations
    idleTimeoutMillis: 30_000,  // close idle connections after 30s
    connectionTimeoutMillis: 3_000, // fail fast — better a quick error than a 5s queue pile-up under load
  });
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
