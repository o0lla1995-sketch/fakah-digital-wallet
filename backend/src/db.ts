// db.ts — PostgreSQL pool + migrations runner
import fs from "fs";
import path from "path";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { config, mapDbError } from "./core";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
});

export async function query<T extends QueryResultRow = any>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
  try {
    return await pool.query<T>(sql, params);
  } catch (e) {
    throw mapDbError(e);
  }
}

export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw mapDbError(e);
  } finally {
    client.release();
  }
}

const MIGRATIONS_DIR = path.join(__dirname, "..", "db");

export async function runMigrations(): Promise<string[]> {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  await tx(async (c) => {
    await c.query(`CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY, filename VARCHAR(120) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set(
      (await c.query<{ filename: string }>("SELECT filename FROM _migrations")).rows.map(r => r.filename)
    );
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8");
      await c.query(sql);
      await c.query("INSERT INTO _migrations (filename) VALUES ($1)", [f]);
      applied.push(f);
    }
  });
  return applied;
}

export async function waitForDb(retries = 30, delayMs = 2000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}
