import { MAX_UPLOAD_BYTES } from "@eaglepanel/shared";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createAgentClient, type AgentTarget } from "./agent-client";
import { createApp } from "./app";
import { openDb } from "./db";
import { createDbUsageMonitor } from "./db-usage";
import { JobRunner } from "./jobs";

const dbPath = process.env.EAGLEPANEL_DB ?? "/var/lib/eaglepanel/eaglepanel.db";
const db = openDb(dbPath);
const jobs = new JobRunner(db);
jobs.markInterrupted();

const target: AgentTarget = process.env.AGENT_URL
  ? { url: process.env.AGENT_URL }
  : { socket: process.env.AGENT_SOCKET ?? "/run/eaglepanel/agent.sock" };

const dist = join(import.meta.dir, "..", "..", "web", "dist");

const agent = createAgentClient(target);
createDbUsageMonitor({ db, agent, jobs }).start();

const panelAddress = process.env.PANEL_ADDRESS?.trim() || undefined;

const app = createApp({
  db,
  jobs,
  agent,
  // serveStatic resolves relative paths against the working directory.
  webDist: existsSync(dist) ? relative(process.cwd(), dist).replaceAll("\\", "/") : undefined,
  secureCookie: process.env.SECURE_COOKIE === "1",
  localAddresses: panelAddress ? [panelAddress] : [],
  schedule: true,
  // Next to the database: the same directory the service already writes to.
  metricsFile: dbPath === ":memory:" ? undefined : join(dirname(dbPath), "metrics.json"),
  rootDir: join(import.meta.dir, "..", "..", ".."),
  dataDir: dbPath === ":memory:" ? undefined : dirname(dbPath),
});

// File manager uploads go up to MAX_UPLOAD_BYTES; the other routes have their own cap.
const serveOptions = { idleTimeout: 0, maxRequestBodySize: MAX_UPLOAD_BYTES + 1024 * 1024, fetch: app.fetch };

// Internal, always on loopback and over HTTP: OLS passes the webhooks to it and the installer checks that it responds.
const port = Number(process.env.API_PORT ?? 8090);
Bun.serve({ ...serveOptions, hostname: "127.0.0.1", port });
console.log(`[api] internal at http://127.0.0.1:${port}`);

// Where the administrator connects: the IP chosen at install time (private, public or a VPN one), over HTTPS.
if (panelAddress) {
  const panelPort = Number(process.env.PANEL_PORT ?? 8090);
  const cert = process.env.PANEL_TLS_CERT ?? "/etc/eaglepanel/tls/panel.crt";
  const key = process.env.PANEL_TLS_KEY ?? "/etc/eaglepanel/tls/panel.key";
  const url = `https://${panelAddress.includes(":") ? `[${panelAddress}]` : panelAddress}:${panelPort}`;
  const listen = () => {
    try {
      Bun.serve({ ...serveOptions, hostname: panelAddress, port: panelPort, tls: { cert: Bun.file(cert), key: Bun.file(key) } });
      console.log(`[api] panel at ${url}`);
    } catch (error) {
      // A VPN IP (Tailscale, WireGuard) may appear after the panel starts: it retries without
      // taking down the internal listener, which keeps receiving the webhooks.
      console.error(`[api] could not listen on ${url}: ${error instanceof Error ? error.message : error}. Retrying in 10 s.`);
      setTimeout(listen, 10_000);
    }
  };
  listen();
}
