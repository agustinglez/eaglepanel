import { DEFAULT_LIMITS, type AgentOpName, type JobDto, type MigrationAccountDto } from "@eaglepanel/shared";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../agent/src/dispatch";
import { SandboxHost } from "../../agent/src/host";
import { HTTPD_CONFIG } from "../../agent/src/ols";
import type { AgentClient } from "./agent-client";
import { createApp } from "./app";
import { hashPassword, setAdminCredentials } from "./auth";
import { openDb, type Db } from "./db";
import { accounts, appEnv, apps, databases, domains, vhosts } from "./db/schema";
import { JobRunner } from "./jobs";
import { createSiteAccount, addEnvironment } from "./test-support";

const PASSWORD = "test-password-value";
const passwordHash = await hashPassword(PASSWORD);
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let host: SandboxHost;
let calls: { op: AgentOpName; params: Record<string, unknown> }[];
const agent: AgentClient = {
  call: (async (op: AgentOpName, params: Record<string, unknown>) => {
    calls.push({ op, params });
    if (op === "php.versions") return { versions: ["85"] };
    const response = await dispatch({ op, params }, host);
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  }) as AgentClient["call"],
};

/** A "server": its database and its panel. Both share the sandbox, which acts as the bucket. */
interface Server { db: Db; jobs: JobRunner; app: ReturnType<typeof createApp>; cookie: string }
async function server(): Promise<Server> {
  const db = openDb(":memory:");
  setAdminCredentials(db, "admin", passwordHash);
  const jobs = new JobRunner(db);
  const app = createApp({ db, agent, jobs });
  const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-eaglepanel": "1" }, body: JSON.stringify({ username: "admin", password: PASSWORD }) });
  return { db, jobs, app, cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
}
const post = (s: Server, path: string, body: unknown = {}) => s.app.request(`/api${path}`, { method: "POST", headers: { "content-type": "application/json", "x-eaglepanel": "1", cookie: s.cookie }, body: JSON.stringify(body) });
/** The API names an environment by its id, which is each server's own. */
async function vidIn(s: Server, hostname: string): Promise<number> {
  const found = s.db.select().from(vhosts).all().find((row) => row.hostname === hostname);
  if (!found) throw new Error(`No environment answers for ${hostname}`);
  return found.id;
}
async function runJob(s: Server, path: string, body: unknown = {}): Promise<JobDto> {
  const created = (await (await post(s, path, body)).json()) as { jobId?: string; error?: string };
  if (!created.jobId) throw new Error(created.error);
  for (let attempt = 0; attempt < 800; attempt += 1) {
    const job = s.jobs.get(created.jobId);
    if (job && job.status !== "pending" && job.status !== "running") return job;
    await Bun.sleep(5);
  }
  throw new Error("The job did not finish");
}

const STORAGE = { endpoint: "https://account.r2.cloudflarestorage.com", bucket: "eaglepanel-backups", region: "auto", accessKeyId: "AKIAEXAMPLE" };
const APP = { kind: "static", repoUrl: "https://github.com/acme/front.git", branch: "main", subdir: "", runtime: "bun", runtimeVersion: "1", buildCommand: "bun run build", startCommand: "", outputDir: "dist", spaFallback: true, healthPath: "/", memoryMb: 0 };

let origin: Server;
let destination: Server;
let source: Record<string, string>;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "eaglepanel-migration-"));
  roots.push(root);
  host = new SandboxHost(root);
  calls = [];
  await host.writeFileAtomic(HTTPD_CONFIG, "serverName test\n");
  origin = await server();
  destination = await server();

  expect((await createSiteAccount((path, body) => runJob(origin, path, body), { username: "acme", domain: "example.com", limits: { ...DEFAULT_LIMITS, quotaMb: 2048 } })).status).toBe("succeeded");
  expect((await runJob(origin, "/accounts/acme/databases", { name: "tienda" })).status).toBe("succeeded");
  expect((await addEnvironment((path, body) => runJob(origin, path, body), "acme", "web.example.com")).status).toBe("succeeded");
  expect((await runJob(origin, `/vhosts/${await vidIn(origin, "web.example.com")}/app`, APP)).status).toBe("succeeded");
  expect((await runJob(origin, `/vhosts/${await vidIn(origin, "web.example.com")}/env`, { vars: [{ key: "API_URL", value: "https://api.example.com", scope: "build" }] })).status).toBe("succeeded");
  const settings = { ...STORAGE, enabled: true, prefix: "origen", secretAccessKey: "secreto-origen", hour: 3 };
  const configured = (await (await post(origin, "/settings/backups", settings)).json()) as { jobId: string; secret: string };
  for (let attempt = 0; attempt < 400 && origin.jobs.get(configured.jobId)?.status !== "succeeded"; attempt += 1) await Bun.sleep(5);
  expect((await runJob(origin, "/backups/run")).status).toBe("succeeded");
  source = { ...STORAGE, prefix: "origen", secretAccessKey: "secreto-origen", password: configured.secret };
  calls = [];
});

describe("mudanza", () => {
  test("lists the source accounts and recreates the full account at the destination", async () => {
    const listed = (await (await post(destination, "/migrations/accounts", { source })).json()) as MigrationAccountDto[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ username: "acme", exists: false, runs: [{ complete: true }] });

    const job = await runJob(destination, "/migrations/import", { source, username: "acme", run: listed[0]!.runs[0]!.run });
    expect(job.status).toBe("succeeded");
    const db = destination.db;
    expect(db.select().from(accounts).get()).toMatchObject({ username: "acme", quotaMb: 2048, suspended: false });
    expect(db.select().from(domains).all().map(({ fqdn }) => fqdn)).toEqual(["example.com"]);
    // Same slug, name and hostname as at the source; the id is this server's.
    expect(db.select().from(vhosts).all().map(({ slug, name, hostname, type }) => [slug, name, hostname, type]).sort()).toEqual([
      ["examplecom", "example.com", "example.com", "php"], ["webexamplecom", "web.example.com", "web.example.com", "app"],
    ]);
    const web = await vidIn(destination, "web.example.com");
    expect(db.select().from(apps).get()).toMatchObject({ vhost: web, repoUrl: APP.repoUrl, buildCommand: APP.buildCommand });
    expect(db.select().from(appEnv).all()).toEqual([{ vhost: web, key: "API_URL", value: "https://api.example.com", scope: "build" }]);
    expect(db.select().from(databases).all().map(({ name }) => name)).toEqual(["acme_tienda"]);

    const ops = calls.map(({ op }) => op);
    expect(ops).toContain("backup.recreateDatabase");
    expect(ops).toContain("backup.restoreFiles");
    // The database and the files come from the source repository; the account at the source stays intact.
    expect((calls.find(({ op }) => op === "backup.restoreFiles")!.params.repo as { repository: string }).repository).toEndWith("/origen");
    expect(origin.db.select().from(accounts).get()?.username).toBe("acme");
  });

  test("stops and warns if the account or a domain already exists at the destination, touching nothing", async () => {
    const [entry] = (await (await post(destination, "/migrations/accounts", { source })).json()) as MigrationAccountDto[];
    const run = entry!.runs[0]!.run;

    expect((await createSiteAccount((path, body) => runJob(destination, path, body), { username: "otra", domain: "example.com", limits: DEFAULT_LIMITS })).status).toBe("succeeded");
    const conflict = await post(destination, "/migrations/import", { source, username: "acme", run });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toContain("example.com is already in use");
    expect(destination.db.select().from(accounts).all().map(({ username }) => username)).toEqual(["otra"]);

    // A slug already used here, even in another account and under another domain: it would not keep its directories.
    const destination3 = await server();
    await runJob(destination3, "/accounts", { username: "tercera", limits: DEFAULT_LIMITS });
    await runJob(destination3, "/accounts/tercera/domains", { domain: "tercera.com" });
    await runJob(destination3, "/accounts/tercera/vhosts", { name: "Ocupado", slug: "webexamplecom", hostname: "tercera.com", phpVersion: "85" });
    const slugTaken = await post(destination3, "/migrations/import", { source, username: "acme", run });
    expect(slugTaken.status).toBe(409);
    expect(((await slugTaken.json()) as { error: string }).error).toContain("slug webexamplecom");

    const destination2 = await server();
    expect((await createSiteAccount((path, body) => runJob(destination2, path, body), { username: "acme", domain: "other.com", limits: DEFAULT_LIMITS })).status).toBe("succeeded");
    const exists = await post(destination2, "/migrations/import", { source, username: "acme", run });
    expect(exists.status).toBe(409);
    expect(((await exists.json()) as { error: string }).error).toContain("An account acme already exists");
  });

  test("with the wrong repository password it reads nothing", async () => {
    const original = agent.call;
    agent.call = (async (op: AgentOpName, params: Record<string, unknown>) => {
      if (op === "backup.snapshots" && (params.repo as { password: string }).password !== source.password) throw new Error("restic failed: wrong password or no key found");
      return original(op, params as never);
    }) as AgentClient["call"];
    try {
      const response = await post(destination, "/migrations/accounts", { source: { ...source, password: "some-other-password" } });
      expect(response.status).toBe(502);
    } finally {
      agent.call = original;
    }
  });

  test("if a step fails, it deletes everything it managed to create", async () => {
    const [entry] = (await (await post(destination, "/migrations/accounts", { source })).json()) as MigrationAccountDto[];
    const original = agent.call;
    agent.call = (async (op: AgentOpName, params: Record<string, unknown>) => {
      if (op === "backup.restoreFiles") throw new Error("connection to the bucket lost");
      return original(op, params as never);
    }) as AgentClient["call"];
    try {
      const job = await runJob(destination, "/migrations/import", { source, username: "acme", run: entry!.runs[0]!.run });
      expect(job.status).toBe("rolled_back");
      expect(job.error).toContain("connection to the bucket lost");
    } finally {
      agent.call = original;
    }
    const db = destination.db;
    expect([db.select().from(accounts).all(), db.select().from(vhosts).all(), db.select().from(apps).all(), db.select().from(databases).all()]).toEqual([[], [], [], []]);
    expect(calls.some(({ op, params }) => op === "account.delete" && params.username === "acme")).toBe(true);
  });
});
