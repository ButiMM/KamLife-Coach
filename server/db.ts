import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 50,                    // Railway postgres allows 100; 50 for app, leaving headroom for scheduler/admin/migrations
  idleTimeoutMillis: 30_000,  // close idle connections after 30s
  connectionTimeoutMillis: 3_000, // fail fast — better a quick error than a 5s queue pile-up under load
});

export const db = drizzle(pool, { schema });
