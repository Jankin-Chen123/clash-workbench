import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { resolve } from "node:path";
import { dataDir } from "./config.js";

export interface Queryable {
  query<T extends Record<string, any> = Record<string, any>>(
    sql: string,
    params?: any[],
  ): Promise<{ rows: T[] }>;
}

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
  : undefined;
const embedded = pool ? undefined : new PGlite(resolve(dataDir, "postgres"));
export const db: Queryable = pool || embedded!;

export async function transaction<T>(
  fn: (connection: Queryable) => Promise<T>,
): Promise<T> {
  if (embedded) return embedded.transaction((connection) => fn(connection));
  const connection = await pool!.connect();
  try {
    await connection.query("BEGIN");
    const value = await fn(connection);
    await connection.query("COMMIT");
    return value;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function initDb() {
  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
    admin BOOLEAN NOT NULL DEFAULT FALSE, ai TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS invitations (
    code TEXT PRIMARY KEY, used BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), revision INTEGER NOT NULL DEFAULT 1,
    content TEXT NOT NULL, subscription_hash TEXT UNIQUE, subscription_token TEXT,
    published TEXT, published_at TIMESTAMPTZ, publish_error TEXT,
    refresh_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content TEXT NOT NULL, label TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.query(
    "CREATE INDEX IF NOT EXISTS projects_owner ON projects(user_id)",
  );
}

export async function closeDb() {
  if (embedded) await embedded.close();
  else await pool!.end();
}
