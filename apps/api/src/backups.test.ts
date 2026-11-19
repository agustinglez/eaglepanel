import { DEFAULT_LIMITS, type AgentOpName, type BackupRunDto, type BackupSettingsDto, type JobDto } from "@eaglepanel/shared";
import type { AccountDto as AccountDtoForVid } from "@eaglepanel/shared";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../agent/src/dispatch";
import { SandboxHost } from "../../agent/src/host";
import { HTTPD_CONFIG } from "../../agent/src/ols";
import type { AgentClient } from "./agent-client";
import { createApp } from "./app";
import { createSiteAccount, addEnvironment } from "./test-support";
import { hashPassword, setAdminCredentials } from "./auth";
import { createBackups, runIdOf } from "./backups";
import { openDb, type Db } from "./db";
import { auditLog, databases, settings } from "./db/schema";
import { JobRunner } from "./jobs";

const PASSWORD = "test-password-value";
const passwordHash = await hashPassword(PASSWORD);
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let host: SandboxHost;
let db: Db;
let jobs: JobRunner;
let app: ReturnType<typeof createApp>;
let cookie: string;
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


/** The API names an environment by its id: the one that answers for that hostname. */
async function vid(hostname: string): Promise<number> {
  const response = await app.request("/api/accounts", { headers: { cookie } });
  for (const item of (await response.json()) as AccountDtoForVid[]) {
    const found = item.vhosts.find((vhost) => vhost.hostname === hostname);
    if (found) return found.id;
  }
  throw new Error(`No environment answers for ${hostname}`);
}

const post = (path: string, body: unknown = {}) => app.request(`/api${path}`, { method: "POST", headers: { "content-type": "application/json", "x-eaglepanel": "1", cookie }, body: JSON.stringify(body) });
const get = (path: string) => app.request(`/api${path}`, { headers: { cookie } });
async function waitFor(jobId: string): Promise<JobDto> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const job = jobs.get(jobId);
    if (job && job.status !== "pending" && job.status !== "running") return job;
    await Bun.sleep(5);
  }
  throw new Error("The job did not finish");
}
async function runJob(path: string, body: unknown = {}): Promise<JobDto & { secret?: string }> {
  const response = await post(path, body);
  const created = (await response.json()) as { jobId: string; secret?: string; error?: string };
  if (!created.jobId) throw new Error(created.error);
  return { ...(await waitFor(created.jobId)), secret: created.secret };
}

const SETTINGS = {
  enabled: true, endpoint: "https://account.r2.cloudflarestorage.com", bucket: "eaglepanel-backups", prefix: "server-1",
  region: "auto", accessKeyId: "AKIAEJEMPLO", secretAccessKey: "test-secret-value", hour: 3,
};

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "eaglepanel-backups-"));
  roots.push(root);
  host = new SandboxHost(root);
  db = openDb(":memory:");
  setAdminCredentials(db, "admin", passwordHash);
  jobs = new JobRunner(db);
  calls = [];
  app = createApp({ db, agent, jobs });
  await host.writeFileAtomic(HTTPD_CONFIG, "serverName test\n");
  const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-eaglepanel": "1" }, body: JSON.stringify({ username: "admin", password: PASSWORD }) });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect((await createSiteAccount(runJob, { username: "acme", domain: "example.com", limits: DEFAULT_LIMITS })).status).toBe("succeeded");
  expect((await runJob("/accounts/acme/databases", { name: "tienda" })).status).toBe("succeeded");
});

describe("ajustes", () => {
  test("when not configured, it does not run and lists nothing", async () => {
    expect(((await (await get("/settings/backups")).json()) as BackupSettingsDto).configured).toBe(false);
    expect((await post("/backups/run")).status).toBe(409);
    expect(await (await get("/accounts/acme/backups")).json()).toEqual([]);
  });

  test("generates the repository password only once and never returns the secrets", async () => {
    const job = await runJob("/settings/backups", SETTINGS);
    expect(job.status).toBe("succeeded");
    expect(job.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const dto = (await (await get("/settings/backups")).json()) as BackupSettingsDto;
    expect(dto).toMatchObject({ configured: true, enabled: true, hasSecret: true, accessKeyId: "AKIAEJEMPLO", hour: 3 });
    expect(JSON.stringify(dto)).not.toContain("test-secret-value");
    expect(JSON.stringify(dto)).not.toContain(job.secret!);

    // Saving again with an empty secret keeps the previous one and does not change the password.
    const again = await runJob("/settings/backups", { ...SETTINGS, secretAccessKey: "", hour: 4 });
    expect(again.secret).toBeUndefined();
    expect(db.select().from(settings).all().find(({ key }) => key === "backup.secretAccessKey")?.value).toBe("test-secret-value");
    expect(db.select().from(settings).all().find(({ key }) => key === "backup.repositoryPassword")?.value).toBe(job.secret);
    // No secrets and no password in the audit log.
    expect(JSON.stringify(db.select().from(auditLog).all())).not.toContain("test-secret-value");
  });

  test("validates the storage", async () => {
    expect((await post("/settings/backups", { ...SETTINGS, endpoint: "http://inseguro.com" })).status).toBe(400);
    expect((await post("/settings/backups", { ...SETTINGS, bucket: "Bucket_Malo" })).status).toBe(400);
    expect((await post("/settings/backups", { ...SETTINGS, secretAccessKey: "" })).status).toBe(400);
  });
});

describe("backups", () => {
  beforeEach(async () => {
    await runJob("/settings/backups", SETTINGS);
    calls = [];
  });

  test("the run stores each account with its manifest and databases, and applies retention", async () => {
    const job = await runJob("/backups/run");
    expect(job.status).toBe("succeeded");
    expect(calls.map(({ op }) => op)).toEqual(["backup.init", "backup.account", "backup.forget"]);
    const account = calls.find(({ op }) => op === "backup.account")!.params;
    expect(account).toMatchObject({ username: "acme", databases: ["acme_tienda"], zones: [], appIds: [] });
    expect((account.repo as { repository: string }).repository).toBe("s3:https://account.r2.cloudflarestorage.com/eaglepanel-backups/server-1");
    const panel = JSON.parse(account.panel as string);
    expect(panel.account.username).toBe("acme");
    expect(panel.domains.map(({ fqdn }: { fqdn: string }) => fqdn)).toEqual(["example.com"]);

    const runs = (await (await get("/accounts/acme/backups")).json()) as BackupRunDto[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ files: expect.any(String), manifest: expect.any(String), databases: [{ name: "acme_tienda", snapshot: expect.any(String) }] });
    expect((await (await get("/settings/backups")).json() as BackupSettingsDto).lastRun).toMatchObject({ ok: true });
  });

  test("a failing account does not stop the others, and the job is marked", async () => {
    expect((await createSiteAccount(runJob, { username: "otra", domain: "otra.com", limits: DEFAULT_LIMITS })).status).toBe("succeeded");
    const original = agent.call;
    agent.call = (async (op: AgentOpName, params: Record<string, unknown>) => {
      if (op === "backup.account" && params.username === "acme") throw new Error("connection lost");
      return original(op, params as never);
    }) as AgentClient["call"];
    try {
      const job = await runJob("/backups/run");
      expect(job.status).toBe("rolled_back");
      expect(job.error).toContain("acme: connection lost");
      expect(((await (await get("/accounts/otra/backups")).json()) as BackupRunDto[])).toHaveLength(1);
    } finally {
      agent.call = original;
    }
  });

  test("restores files and databases only from backups of the same account", async () => {
    await runJob("/backups/run");
    expect((await createSiteAccount(runJob, { username: "otra", domain: "otra.com", limits: DEFAULT_LIMITS })).status).toBe("succeeded");
    const [run] = (await (await get("/accounts/acme/backups")).json()) as BackupRunDto[];
    expect((await runJob("/accounts/acme/backups/restore-files", { snapshot: run!.files, path: "public_html", mode: "folder" })).status).toBe("succeeded");
    expect((await runJob("/accounts/acme/backups/restore-database", { snapshot: run!.databases[0]!.snapshot, database: "acme_tienda" })).status).toBe("succeeded");

    const foreign = await runJob("/accounts/otra/backups/restore-files", { snapshot: run!.files, path: "", mode: "inplace" });
    expect(foreign.status).toBe("rolled_back");
    expect(foreign.error).toContain("does not belong to this account");
    expect((await post("/accounts/otra/backups/restore-database", { snapshot: run!.databases[0]!.snapshot, database: "acme_tienda" })).status).toBe(404);
    expect((await post("/accounts/acme/backups/restore-files", { snapshot: run!.files, path: "../otra", mode: "inplace" })).status).toBe(400);
  });

  test("backups do not block the rest of the panel", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const original = agent.call;
    agent.call = (async (op: AgentOpName, params: Record<string, unknown>) => {
      if (op === "backup.account") await blocked;
      return original(op, params as never);
    }) as AgentClient["call"];
    try {
      const backup = (await (await post("/backups/run")).json()) as { jobId: string };
      // While the backup waits, creating a database still finishes.
      expect((await runJob("/accounts/acme/databases", { name: "blog" })).status).toBe("succeeded");
      expect(jobs.get(backup.jobId)?.status).toBe("running");
      release();
      expect((await waitFor(backup.jobId)).status).toBe("succeeded");
    } finally {
      agent.call = original;
    }
    expect(db.select().from(databases).all().map(({ name }) => name).sort()).toEqual(["acme_blog", "acme_tienda"]);
  });

  test("the daily backup runs once a day at the chosen time", async () => {
    const backups = createBackups({ db, agent, jobs });
    const at = (hour: number, day = 7) => new Date(2026, 10, day, hour, 30);
    backups.tick(at(2));
    expect(jobs.list().filter(({ type }) => type === "backup.run")).toHaveLength(0);
    backups.tick(at(3));
    backups.tick(at(3));
    expect(jobs.list().filter(({ type }) => type === "backup.run")).toHaveLength(1);
    backups.tick(at(3, 8));
    expect(jobs.list().filter(({ type }) => type === "backup.run")).toHaveLength(2);
    expect(runIdOf(Date.UTC(2026, 10, 7, 3, 0, 5))).toBe("20261107T030005Z");
    for (const job of jobs.list()) await waitFor(job.id);
  });
});

describe("etapa 2", () => {
  beforeEach(async () => {
    await runJob("/settings/backups", SETTINGS);
    calls = [];
  });

  test("does not back up suspended accounts", async () => {
    expect((await createSiteAccount(runJob, { username: "otra", domain: "otra.com", limits: DEFAULT_LIMITS })).status).toBe("succeeded");
    expect((await runJob("/accounts/otra/suspend", { suspended: true })).status).toBe("succeeded");
    calls = [];
    expect((await runJob("/backups/run")).status).toBe("succeeded");
    expect(calls.filter(({ op }) => op === "backup.account").map(({ params }) => params.username)).toEqual(["acme"]);
    const manual = await post("/accounts/otra/backups/run");
    expect(manual.status).toBe(409);
  });

  test("deleting an account deletes its backups, and those of a new account with the same name are untouched", async () => {
    await runJob("/backups/run");
    expect(((await (await get("/accounts/acme/backups")).json()) as BackupRunDto[])).toHaveLength(1);
    expect((await runJob("/accounts/acme/delete", { confirm: "acme" })).status).toBe("succeeded");
    expect(calls.some(({ op, params }) => op === "backup.purge" && params.username === "acme")).toBe(true);
    expect((await (await get("/settings/backups")).json() as BackupSettingsDto).pendingPurges).toEqual([]);

    expect((await createSiteAccount(runJob, { username: "acme", domain: "example.com", limits: DEFAULT_LIMITS })).status).toBe("succeeded");
    expect(((await (await get("/accounts/acme/backups")).json()) as BackupRunDto[])).toHaveLength(0);
    await runJob("/accounts/acme/backups/run");
    expect(((await (await get("/accounts/acme/backups")).json()) as BackupRunDto[])).toHaveLength(1);
  });

  test("if the backups cannot be deleted, the account is deleted anyway and it is retried on the run", async () => {
    await runJob("/backups/run");
    const original = agent.call;
    let failPurge = true;
    agent.call = (async (op: AgentOpName, params: Record<string, unknown>) => {
      if (op === "backup.purge" && failPurge) throw new Error("the bucket does not respond");
      return original(op, params as never);
    }) as AgentClient["call"];
    try {
      expect((await runJob("/accounts/acme/delete", { confirm: "acme" })).status).toBe("succeeded");
      expect((await (await get("/settings/backups")).json() as BackupSettingsDto).pendingPurges).toEqual(["acme"]);
      failPurge = false;
      expect((await runJob("/backups/run")).status).toBe("succeeded");
      expect((await (await get("/settings/backups")).json() as BackupSettingsDto).pendingPurges).toEqual([]);
    } finally {
      agent.call = original;
    }
  });

  test("recreates a database deleted from the panel with its user and loads it", async () => {
    await runJob("/backups/run");
    const [run] = (await (await get("/accounts/acme/backups")).json()) as BackupRunDto[];
    expect((await runJob("/accounts/acme/databases/acme_tienda/delete")).status).toBe("succeeded");
    expect((await post("/accounts/acme/backups/restore-database", { snapshot: run!.databases[0]!.snapshot, database: "acme_tienda" })).status).toBe(400);
    calls = [];
    const job = await runJob("/accounts/acme/backups/restore-database", { snapshot: run!.databases[0]!.snapshot, database: "acme_tienda", manifest: run!.manifest });
    expect(job.status).toBe("succeeded");
    expect(calls.map(({ op }) => op)).toEqual(["backup.manifest", "backup.recreateDatabase", "backup.restoreDatabase"]);
    expect(calls[1]!.params.authHash).toBe(`0x${"AB".repeat(35)}`);
    expect(db.select().from(databases).all().map(({ name }) => name)).toEqual(["acme_tienda"]);
  });

  test("restores environment options and app variables, and does not mix accounts", async () => {
    expect((await addEnvironment(runJob, "acme", "web.example.com")).status).toBe("succeeded");
    const app = { kind: "static", repoUrl: "https://github.com/acme/front.git", branch: "main", subdir: "", runtime: "bun", runtimeVersion: "1", buildCommand: "bun run build", startCommand: "", outputDir: "dist", spaFallback: true, healthPath: "/", memoryMb: 0 };
    expect((await runJob(`/vhosts/${await vid("web.example.com")}/app`, app)).status).toBe("succeeded");
    expect((await runJob(`/vhosts/${await vid("web.example.com")}/env`, { vars: [{ key: "API_URL", value: "https://api.example.com", scope: "build" }] })).status).toBe("succeeded");
    await runJob("/backups/run");
    const [run] = (await (await get("/accounts/acme/backups")).json()) as BackupRunDto[];

    expect((await runJob(`/vhosts/${await vid("web.example.com")}/env`, { vars: [] })).status).toBe("succeeded");
    const web = await vid("web.example.com");
    const summary = await (await get(`/accounts/acme/backups/manifest/${run!.manifest}`)).json() as { vhosts: { id: number | null; name: string; envKeys: string[]; app: boolean }[] };
    expect(summary.vhosts.find(({ id }) => id === web)).toMatchObject({ name: "web.example.com", envKeys: ["API_URL"], app: true });
    expect(JSON.stringify(summary)).not.toContain("https://api.example.com");

    const job = await runJob("/accounts/acme/backups/restore-config", { manifest: run!.manifest, vhosts: [web], parts: ["env", "app"] });
    expect(job.status).toBe("succeeded");
    const vhost = (await (await get("/accounts/acme")).json() as { vhosts: { id: number; app: { env: { key: string; value: string; scope: string }[] } | null }[] }).vhosts.find(({ id }) => id === web);
    expect(vhost?.app?.env).toEqual([{ key: "API_URL", value: "https://api.example.com", scope: "build" }]);

    expect((await createSiteAccount(runJob, { username: "otra", domain: "otra.com", limits: DEFAULT_LIMITS })).status).toBe("succeeded");
    expect((await get(`/accounts/otra/backups/manifest/${run!.manifest}`)).status).toBe(400);
    expect((await post("/accounts/otra/backups/restore-config", { manifest: run!.manifest, vhosts: [web], parts: ["env"] })).status).toBe(400);
  });
});

describe("downloadable copy", () => {
  test("a suspended account generates and downloads its copy, even without backups configured", async () => {
    expect((await runJob("/accounts/acme/suspend", { suspended: true })).status).toBe("succeeded");
    const job = await runJob("/accounts/acme/exports");
    expect(job.status).toBe("succeeded");
    const [item] = (await (await get("/accounts/acme/exports")).json()) as { id: string; status: string; sizeBytes: number; expiresAt: number; createdAt: number }[];
    expect(item).toMatchObject({ status: "ready" });
    expect(item!.expiresAt - item!.createdAt).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(calls.find(({ op }) => op === "export.create")?.params).toMatchObject({ username: "acme", databases: ["acme_tienda"] });
  });

  test("a new copy replaces the previous one, and cannot be downloaded from another account", async () => {
    await runJob("/accounts/acme/exports");
    const [first] = (await (await get("/accounts/acme/exports")).json()) as { id: string }[];
    await runJob("/accounts/acme/exports");
    const list = (await (await get("/accounts/acme/exports")).json()) as { id: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.id).not.toBe(first!.id);
    expect((await createSiteAccount(runJob, { username: "otra", domain: "otra.com", limits: DEFAULT_LIMITS })).status).toBe("succeeded");
    expect((await get(`/accounts/otra/exports/${list[0]!.id}/download`)).status).toBe(404);
  });

  test("expired copies are deleted, and deleting the account deletes its copies", async () => {
    await runJob("/accounts/acme/exports");
    const backups = createBackups({ db, agent, jobs });
    calls = [];
    await backups.expireExports(Date.now() + 25 * 60 * 60 * 1000);
    expect(calls.map(({ op }) => op)).toEqual(["export.delete"]);
    expect(await (await get("/accounts/acme/exports")).json()).toEqual([]);

    await runJob("/accounts/acme/exports");
    calls = [];
    expect((await runJob("/accounts/acme/delete", { confirm: "acme" })).status).toBe("succeeded");
    expect(calls.some(({ op }) => op === "export.delete")).toBe(true);
  });
});
