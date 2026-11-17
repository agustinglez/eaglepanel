import { eq } from "drizzle-orm";
import type { AgentClient } from "./agent-client";
import { audit } from "./audit";
import type { Db } from "./db";
import { accounts, databases } from "./db/schema";
import type { JobRunner } from "./jobs";

const MB = 1024 * 1024;
/** A 38 MB/s write measured on the VPS fills hundreds of MB between two 5-minute measurements. */
export const DB_USAGE_INTERVAL_MS = 60_000;
/** With little disk left, MySQL can corrupt data when it fills up: writes are cut for every account. */
export const DISK_BLOCK_BYTES = 1024 * MB;
/** Margin so it does not block and unblock on every measurement while the disk hovers around the threshold. */
export const DISK_UNBLOCK_BYTES = 2048 * MB;

export interface DbUsageDeps {
  db: Db;
  agent: AgentClient;
  jobs: JobRunner;
}

/** Measures the databases, stores their size and blocks or releases writes for the accounts that crossed a limit. */
export function createDbUsageMonitor({ db, agent, jobs }: DbUsageDeps) {
  let diskLow = false;
  /** A change already queued is not requested again on the next measurement. */
  const pending = new Set<string>();

  async function measure(): Promise<void> {
    const usage = await agent.call("db.usage", {});
    const sizes = new Map(usage.databases.map(({ name, bytes }) => [name, bytes]));

    // Without a disk measurement the last state is kept: not knowing is not the same as being full.
    if (usage.diskFreeBytes !== null) {
      if (usage.diskFreeBytes < DISK_BLOCK_BYTES) diskLow = true;
      else if (usage.diskFreeBytes >= DISK_UNBLOCK_BYTES) diskLow = false;
    }

    const rows = db.select().from(databases).all();
    for (const row of rows) {
      const sizeBytes = sizes.get(row.name) ?? 0;
      if (sizeBytes !== row.sizeBytes) db.update(databases).set({ sizeBytes }).where(eq(databases.name, row.name)).run();
    }

    for (const account of db.select().from(accounts).all()) {
      const own = rows.filter((row) => row.username === account.username);
      const usedBytes = own.reduce((total, row) => total + (sizes.get(row.name) ?? 0), 0);
      const shouldBlock = diskLow || usedBytes >= account.dbStorageMb * MB;
      if (shouldBlock === account.dbBlocked || pending.has(account.username)) continue;

      // Read only when it runs: in between, the account may have created or deleted databases.
      const username = account.username;
      pending.add(username);
      const { done } = jobs.enqueue({
        type: "database.block",
        title: shouldBlock ? `Block writes on the databases of ${username}` : `Allow writes on the databases of ${username}`,
        steps: [{
          name: shouldBlock ? "Revoke write privileges and close connections" : "Restore privileges",
          run: async () => {
            const names = db.select({ name: databases.name }).from(databases).where(eq(databases.username, username)).all().map(({ name }) => name);
            await agent.call("db.setWritable", { databases: names, writable: !shouldBlock });
            db.update(accounts).set({ dbBlocked: shouldBlock }).where(eq(accounts.username, username)).run();
          },
        }],
      });
      audit(db, "database.block", `${username}: ${shouldBlock ? (diskLow ? "blocked: low disk space" : "blocked: over the limit") : "released"}`);
      void done.finally(() => pending.delete(username));
    }
  }

  return {
    measure,
    start() {
      const timer = setInterval(() => {
        measure().catch((error: unknown) => console.error("[api] could not measure databases:", error));
      }, DB_USAGE_INTERVAL_MS);
      return () => clearInterval(timer);
    },
  };
}
