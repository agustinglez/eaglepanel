import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as schema from "./schema";

export type Db = BunSQLiteDatabase<typeof schema> & { $client: Database };

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "drizzle");

/** `migrationsFolder` is only for tests: the panel always uses its own migrations. */
export function openDb(path: string, { migrationsFolder = MIGRATIONS_DIR } = {}): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const sqlite = new Database(path, { create: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") {
    // Stores TOTP secrets and hashes: only the service user can read it.
    chmodSync(path, 0o600);
  }
  try {
    migrate(sqlite, migrationsFolder);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  sqlite.run("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

/**
 * Applies the pending migrations as SQLite recommends for changing a schema: foreign keys off, everything in one
 * transaction, `foreign_key_check` and only then COMMIT. With them on, rebuilding a table (create the new one, copy,
 * drop the old one, rename) would delete in cascade everything that points to it; and SQLite ignores `foreign_keys`
 * inside a transaction. If a migration fails or leaves references pointing nowhere, nothing is written and the panel
 * does not start.
 *
 * It is drizzle's migrator with that check before committing (drizzle commits on its own): the same table, the same
 * record per migration and the same rule to know which are pending, so existing installs simply continue.
 */
function migrate(sqlite: Database, migrationsFolder: string) {
  sqlite.run(`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
  const last = (sqlite.query(`SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`).get() as { created_at: number } | null)?.created_at;
  const pending = readMigrationFiles({ migrationsFolder }).filter((migration) => last === undefined || Number(last) < migration.folderMillis);
  if (pending.length === 0) return;

  // Outside the transaction: inside it, SQLite ignores this.
  sqlite.run("PRAGMA foreign_keys = OFF");
  sqlite.transaction(() => {
    for (const migration of pending) {
      for (const statement of migration.sql) if (statement.trim()) sqlite.run(statement);
      sqlite.run(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`, [migration.hash, migration.folderMillis]);
    }
    const broken = sqlite.query("PRAGMA foreign_key_check").all() as { table: string; parent: string }[];
    if (broken.length > 0) {
      const sample = broken.slice(0, 5).map((row) => `${row.table} -> ${row.parent}`).join(", ");
      // Throwing inside the transaction rolls it back: nothing of the migration is left.
      throw new Error(`The database migration would leave ${broken.length} broken references (${sample}): nothing was changed`);
    }
  })();
}

export { schema };
