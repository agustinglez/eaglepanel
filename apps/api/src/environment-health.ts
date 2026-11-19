import type { EnvironmentHealth, EnvironmentHealthDto } from "@eaglepanel/shared";
import { eq } from "drizzle-orm";
import type { AgentClient } from "./agent-client";
import type { Db } from "./db";
import { accounts, apps, vhosts } from "./db/schema";

/** Results are reused for a minute: the overview asks often and every check is a request to OLS. */
const CACHE_MS = 60_000;
const TIMEOUT_MS = 5_000;

interface Probe {
  status: number | null;
  ms: number | null;
}

/**
 * Asks OLS on 127.0.0.1:80 for each environment, by its hostname (Host header), without following redirects.
 * An environment with a certificate answers 301 to HTTPS there: that confirms OLS serves it, not that the app behind
 * is healthy. The app status (failed, stopped) comes from the panel database.
 */
async function probe(fqdn: string): Promise<Probe> {
  const start = performance.now();
  try {
    const response = await fetch("http://127.0.0.1/", {
      headers: { host: fqdn, "user-agent": "EaglePanel health check" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
    return { status: response.status, ms: Math.round(performance.now() - start) };
  } catch {
    return { status: null, ms: null };
  }
}

export function createEnvironmentHealth({ db, agent }: { db: Db; agent: AgentClient }) {
  let cache: { at: number; data: EnvironmentHealthDto[] } | null = null;
  let running: Promise<EnvironmentHealthDto[]> | null = null;

  async function check(): Promise<EnvironmentHealthDto[]> {
    const rows = db
      .select({ id: vhosts.id, name: vhosts.name, hostname: vhosts.hostname, suspended: accounts.suspended, appStatus: apps.status })
      .from(vhosts)
      .innerJoin(accounts, eq(vhosts.username, accounts.username))
      .leftJoin(apps, eq(apps.vhost, vhosts.id))
      .all();

    // In sandbox mode there is no OLS: nothing is checked.
    const sandbox = await agent.call("system.info", {}).then((info) => info.sandbox).catch(() => false);
    const checkedAt = Date.now();

    return Promise.all(
      rows.map(async ({ id, name, hostname, suspended, appStatus }): Promise<EnvironmentHealthDto> => {
        if (suspended) return { id, name, health: "suspended", httpStatus: null, responseMs: null, checkedAt };
        if (appStatus === "deploying") return { id, name, health: "deploying", httpStatus: null, responseMs: null, checkedAt };
        if (appStatus === "stopped" || appStatus === "new") return { id, name, health: "inactive", httpStatus: null, responseMs: null, checkedAt };
        if (sandbox) return { id, name, health: appStatus === "failed" ? "down" : "unknown", httpStatus: null, responseMs: null, checkedAt: null };

        const { status, ms } = await probe(hostname);
        const health: EnvironmentHealth = appStatus === "failed" || status === null || status >= 500 ? "down" : "online";
        return { id, name, health, httpStatus: status, responseMs: ms, checkedAt };
      }),
    );
  }

  return {
    async get(): Promise<EnvironmentHealthDto[]> {
      if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
      running ??= check()
        .then((data) => {
          cache = { at: Date.now(), data };
          return data;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}
