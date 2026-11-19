import { DEFAULT_LIMITS, DEFAULT_PHP_OPTIONS, type AccountDto, type AgentOpName, type JobDto } from "@eaglepanel/shared";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../agent/src/dispatch";
import { SandboxHost } from "../../agent/src/host";
import { HTTPD_CONFIG } from "../../agent/src/ols";
import type { AgentClient } from "./agent-client";
import { createApp } from "./app";
import { hashPassword, setAdminCredentials } from "./auth";
import { openDb, type Db } from "./db";
import { createDbUsageMonitor } from "./db-usage";
import { auditLog, certificates, jobSteps } from "./db/schema";
import { JobRunner } from "./jobs";
import { createSiteAccount, addEnvironment, testSlug } from "./test-support";

const PASSWORD = "test-password-value";
const passwordHash = await hashPassword(PASSWORD);
const MB = 1024 * 1024;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let root: string;
let host: SandboxHost;
let db: Db;
let jobs: JobRunner;
let app: ReturnType<typeof createApp>;
let cookie: string;
let usage: { databases: { name: string; bytes: number }[]; diskFreeBytes: number | null };
let calls: { op: AgentOpName; params: unknown }[];
let failOn: AgentOpName | null;

const agent: AgentClient = {
  call: (async (op: AgentOpName, params: unknown) => {
    calls.push({ op, params });
    if (op === "php.versions") return { versions: ["85", "84"] };
    if (op === "db.usage") return usage;
    if (failOn === op) {
      failOn = null;
      throw new Error(`simulated failure in ${op}`);
    }
    const response = await dispatch({ op, params }, host);
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  }) as AgentClient["call"],
};


/** The API names an environment by its id: the one that answers for that hostname. */
async function vid(hostname: string): Promise<number> {
  const response = await app.request("/api/accounts", { headers: { cookie } });
  for (const item of (await response.json()) as AccountDto[]) {
    const found = item.vhosts.find((vhost) => vhost.hostname === hostname);
    if (found) return found.id;
  }
  throw new Error(`No environment answers for ${hostname}`);
}

function post(path: string, body: unknown = {}, withCookie = cookie) {
  return app.request(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eaglepanel": "1", cookie: withCookie },
    body: JSON.stringify(body),
  });
}

const account = async (username = "acme") => (await (await app.request(`/api/accounts/${username}`, { headers: { cookie } })).json()) as AccountDto;

async function waitFor(jobId: string): Promise<JobDto> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = jobs.get(jobId);
    if (job && job.status !== "pending" && job.status !== "running") return job;
    await Bun.sleep(5);
  }
  throw new Error("The job did not finish");
}

async function runJob(path: string, body: unknown = {}): Promise<JobDto & { secret?: string }> {
  const response = await post(path, body);
  expect(response.status).toBe(202);
  const { jobId, secret } = (await response.json()) as { jobId: string; secret?: string };
  return { ...(await waitFor(jobId)), secret };
}

const commands = () => readFileSync(join(root, "commands.log"), "utf8");
const callsTo = (op: AgentOpName) => calls.filter((entry) => entry.op === op).map((entry) => entry.params);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "eaglepanel-services-"));
  roots.push(root);
  host = new SandboxHost(root);
  usage = { databases: [], diskFreeBytes: 50_000 * MB };
  calls = [];
  failOn = null;
  db = openDb(":memory:");
  setAdminCredentials(db, "admin", passwordHash);
  jobs = new JobRunner(db);
  app = createApp({ db, agent, jobs });
  await host.writeFileAtomic(HTTPD_CONFIG, "serverName test\n");
  const login = await post("/auth/login", { username: "admin", password: PASSWORD }, "");
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const created = await createSiteAccount(runJob, { username: "acme", domain: "example.com", limits: { ...DEFAULT_LIMITS, quotaMb: 500, databases: 2, dbStorageMb: 10 } });
  expect(created.status).toBe("succeeded");
  calls = [];
});

/** What is stored in the database, the jobs and the audit log, to check that it contains no password. */
function persisted(): string {
  return JSON.stringify([db.select().from(auditLog).all(), db.select().from(jobSteps).all()]);
}

describe("FTP", () => {
  test("creating the account creates its FTP and returns the password only once", async () => {
    const created = await runJob("/accounts", { username: "otra", limits: DEFAULT_LIMITS });
    expect(created.status).toBe("succeeded");
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await account("otra")).ftpPasswordChangedAt).toBeNumber();
    expect(persisted()).not.toContain(created.secret!);
    expect(commands()).not.toContain(created.secret!);
    expect(JSON.stringify(await account("otra"))).not.toContain(created.secret!);
  });

  test("regenerating gives a new password and updates the date", async () => {
    const before = (await account()).ftpPasswordChangedAt;
    await Bun.sleep(2);
    const job = await runJob("/accounts/acme/ftp/password");
    expect(job.status).toBe("succeeded");
    expect((await account()).ftpPasswordChangedAt).toBeGreaterThan(before!);
    expect(callsTo("ftp.setPassword")).toEqual([{ username: "acme", password: job.secret }]);
  });

  test("if FTP fails while creating the account, nothing is left", async () => {
    failOn = "ftp.setPassword";
    const job = await createSiteAccount(runJob, { username: "falla", domain: "falla.com", limits: DEFAULT_LIMITS });
    expect(job.status).toBe("rolled_back");
    expect((await app.request("/api/accounts/falla", { headers: { cookie } })).status).toBe(404);
    expect(callsTo("account.delete")).toEqual([{ username: "falla" }]);
  });
});

describe("databases", () => {
  test("creates the database, returns the password and does not store it", async () => {
    const job = await runJob("/accounts/acme/databases", { name: "tienda" });
    expect(job.status).toBe("succeeded");
    expect(job.secret).toBeString();
    expect((await account()).databases).toEqual([{ name: "acme_tienda", sizeBytes: 0 }]);
    expect(persisted()).not.toContain(job.secret!);
    expect(commands()).not.toContain(job.secret!);
  });

  test("respects the database limit and does not repeat names", async () => {
    await runJob("/accounts/acme/databases", { name: "one" });
    expect((await post("/accounts/acme/databases", { name: "one" })).status).toBe(409);
    await runJob("/accounts/acme/databases", { name: "dos" });
    const response = await post("/accounts/acme/databases", { name: "tres" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The account reached its limit of 2 databases" });
  });

  test("does not operate on another account's database", async () => {
    await createSiteAccount(runJob, { username: "otra", domain: "otra.com", limits: DEFAULT_LIMITS });
    await runJob("/accounts/otra/databases", { name: "privada" });
    calls = [];
    for (const action of ["password", "optimize", "delete"]) {
      expect((await post(`/accounts/acme/databases/otra_privada/${action}`)).status).toBe(404);
      expect((await post(`/accounts/acme/databases/mysql/${action}`)).status).toBe(404);
    }
    expect(calls).toEqual([]);
    expect((await account("otra")).databases).toHaveLength(1);
  });

  test("if creation fails, it is undone", async () => {
    failOn = "db.create";
    const job = await runJob("/accounts/acme/databases", { name: "tienda" });
    expect(job.status).toBe("rolled_back");
    expect((await account()).databases).toEqual([]);
    expect(callsTo("db.delete")).toEqual([{ username: "acme", name: "tienda" }]);
  });

  test("delete, optimize and regenerate reach the agent with the short part of the name", async () => {
    await runJob("/accounts/acme/databases", { name: "tienda" });
    const regenerated = await runJob("/accounts/acme/databases/acme_tienda/password");
    expect(callsTo("db.setPassword")).toEqual([{ username: "acme", name: "tienda", password: regenerated.secret }]);
    await runJob("/accounts/acme/databases/acme_tienda/optimize");
    expect(callsTo("db.optimize")).toEqual([{ username: "acme", name: "tienda" }]);
    await runJob("/accounts/acme/databases/acme_tienda/delete");
    expect((await account()).databases).toEqual([]);
  });

  test("deleting the account deletes its databases", async () => {
    await runJob("/accounts/acme/databases", { name: "tienda" });
    const job = await runJob("/accounts/acme/delete", { confirm: "acme" });
    expect(job.status).toBe("succeeded");
    expect(callsTo("db.delete")).toEqual([{ username: "acme", name: "tienda" }]);
  });
});

describe("database measurement and blocking", () => {
  const measureAndSettle = async () => {
    await monitor().measure();
    // Waits for whatever the measurement queued to finish.
    await jobs.enqueue({ type: "test", title: "esperar", steps: [] }).done;
  };
  let current: ReturnType<typeof createDbUsageMonitor> | null = null;
  const monitor = () => (current ??= createDbUsageMonitor({ db, agent, jobs }));
  beforeEach(async () => {
    current = null;
    await runJob("/accounts/acme/databases", { name: "tienda" });
    calls = [];
  });

  test("stores the size and does not block below the limit", async () => {
    usage.databases = [{ name: "acme_tienda", bytes: 9 * MB }, { name: "mysql", bytes: 500 * MB }];
    await measureAndSettle();
    const updated = await account();
    expect(updated.databases[0]?.sizeBytes).toBe(9 * MB);
    expect(updated.dbBlocked).toBe(false);
    expect(callsTo("db.setWritable")).toEqual([]);
  });

  test("blocks when reaching the limit, without repeating, and releases when going down", async () => {
    usage.databases = [{ name: "acme_tienda", bytes: 10 * MB }];
    await measureAndSettle();
    expect((await account()).dbBlocked).toBe(true);
    expect(callsTo("db.setWritable")).toEqual([{ databases: ["acme_tienda"], writable: false }]);

    await measureAndSettle();
    expect(callsTo("db.setWritable")).toHaveLength(1);

    usage.databases = [{ name: "acme_tienda", bytes: 2 * MB }];
    await measureAndSettle();
    expect((await account()).dbBlocked).toBe(false);
    expect(callsTo("db.setWritable")[1]).toEqual({ databases: ["acme_tienda"], writable: true });
  });

  test("a blocked account does not create new databases", async () => {
    usage.databases = [{ name: "acme_tienda", bytes: 10 * MB }];
    await measureAndSettle();
    expect((await post("/accounts/acme/databases", { name: "otra" })).status).toBe(409);
  });

  test("with low disk it blocks everyone, and releases only with margin", async () => {
    usage.databases = [{ name: "acme_tienda", bytes: MB }];
    usage.diskFreeBytes = 500 * MB;
    await measureAndSettle();
    expect((await account()).dbBlocked).toBe(true);

    usage.diskFreeBytes = 1500 * MB;
    await measureAndSettle();
    expect((await account()).dbBlocked).toBe(true);

    usage.diskFreeBytes = 3000 * MB;
    await measureAndSettle();
    expect((await account()).dbBlocked).toBe(false);
  });

  test("not knowing the free disk space blocks nobody", async () => {
    usage.databases = [{ name: "acme_tienda", bytes: MB }];
    usage.diskFreeBytes = null;
    await measureAndSettle();
    expect((await account()).dbBlocked).toBe(false);
  });

  test("if blocking fails, it retries on the next measurement", async () => {
    usage.databases = [{ name: "acme_tienda", bytes: 10 * MB }];
    failOn = "db.setWritable";
    await measureAndSettle();
    expect((await account()).dbBlocked).toBe(false);
    await measureAndSettle();
    expect((await account()).dbBlocked).toBe(true);
  });
});

describe("Redis and Memcached", () => {
  test("start disabled and show their socket outside the home directory", async () => {
    const { services } = await account();
    expect(services.redis).toEqual({ enabled: false, memoryMb: 64, socket: "/run/eaglepanel-services/redis-acme/redis.sock" });
    expect(services.memcached.socket).toBe("/run/eaglepanel-services/memcached-acme/memcached.sock");
  });

  test("enables each service separately and stores the memory", async () => {
    const job = await runJob("/accounts/acme/services/redis", { enabled: true, memoryMb: 128 });
    expect(job.status).toBe("succeeded");
    const { services } = await account();
    expect(services.redis).toMatchObject({ enabled: true, memoryMb: 128 });
    expect(services.memcached.enabled).toBe(false);
  });

  test("if it fails, it goes back to the previous state", async () => {
    failOn = "service.set";
    const job = await runJob("/accounts/acme/services/redis", { enabled: true, memoryMb: 128 });
    expect(job.status).toBe("rolled_back");
    expect(callsTo("service.set").at(-1)).toEqual({ username: "acme", service: "redis", enabled: false, memoryMb: 64 });
    expect((await account()).services.redis).toMatchObject({ enabled: false, memoryMb: 64 });
  });

  test("rejects an unknown service", async () => {
    expect((await post("/accounts/acme/services/ssh", { enabled: true, memoryMb: 64 })).status).toBe(404);
  });
});

describe("accept connections from Cloudflare only", () => {
  const conf = (fqdn: string) => readFileSync(host.resolvePath(`/usr/local/lsws/conf/vhosts/${testSlug(fqdn)}/vhost.conf`), "utf8");
  const syncedSites = () => (callsTo("ols.sync").at(-1) as { sites: { hostname: string; originPull: boolean }[] }).sites;
  const installCertificate = () => db.insert(certificates).values({ zone: "example.com", username: "acme", names: ["example.com", "*.example.com"], notAfter: Date.now() + 86_400_000 }).run();

  test("cannot be enabled without a certificate", async () => {
    expect((await post("/accounts/acme/domains/example.com/origin-pull", { enabled: true })).status).toBe(404);
  });

  test("starts disabled: enabling it without the Cloudflare switch would take the domain down", async () => {
    installCertificate();
    expect((await account()).domains[0]?.certificate?.originPull).toBe(false);
  });

  test("enables the requirement on every covered environment, and not on those left out", async () => {
    await runJob("/accounts/acme/limits", { ...DEFAULT_LIMITS, quotaMb: 500, databases: 2, dbStorageMb: 10 });
    await addEnvironment(runJob, "acme", "blog.example.com");
    await addEnvironment(runJob, "acme", "a.blog.example.com");
    installCertificate();

    const job = await runJob("/accounts/acme/domains/example.com/origin-pull", { enabled: true });
    expect(job.status).toBe("succeeded");
    expect((await account()).domains[0]?.certificate?.originPull).toBe(true);
    expect(conf("example.com")).toContain("clientVerify            2");
    expect(conf("blog.example.com")).toContain("clientVerify            2");
    // The wildcard covers a single level: that environment is not on 443.
    expect(conf("a.blog.example.com")).not.toContain("clientVerify");
    expect(syncedSites().find(({ hostname }) => hostname === "a.blog.example.com")?.originPull).toBe(false);
    expect(syncedSites().find(({ hostname }) => hostname === "blog.example.com")?.originPull).toBe(true);
    expect(callsTo("ols.sync").at(-1)).toMatchObject({ restart: true });
  });

  test("does not affect another account, and cannot be enabled from another one", async () => {
    await createSiteAccount(runJob, { username: "otra", domain: "otra.com", limits: DEFAULT_LIMITS });
    installCertificate();
    expect((await post("/accounts/otra/domains/example.com/origin-pull", { enabled: true })).status).toBe(404);
    await runJob("/accounts/acme/domains/example.com/origin-pull", { enabled: true });
    expect(conf("otra.com")).not.toContain("clientVerify");
  });

  test("repeating the same state does not restart OLS", async () => {
    installCertificate();
    expect((await post("/accounts/acme/domains/example.com/origin-pull", { enabled: false })).status).toBe(409);
    expect(callsTo("ols.sync")).toEqual([]);
  });

  test("can be disabled", async () => {
    installCertificate();
    await runJob("/accounts/acme/domains/example.com/origin-pull", { enabled: true });
    const job = await runJob("/accounts/acme/domains/example.com/origin-pull", { enabled: false });
    expect(job.status).toBe("succeeded");
    expect(conf("example.com")).not.toContain("clientVerify");
  });

  test("if OLS fails, it goes back to the previous state", async () => {
    installCertificate();
    failOn = "ols.sync";
    const job = await runJob("/accounts/acme/domains/example.com/origin-pull", { enabled: true });
    expect(job.status).toBe("rolled_back");
    expect((await account()).domains[0]?.certificate?.originPull).toBe(false);
    expect(conf("example.com")).not.toContain("clientVerify");
  });
});

describe("suspend account", () => {
  const conf = (fqdn = "example.com") => readFileSync(host.resolvePath(`/usr/local/lsws/conf/vhosts/${testSlug(fqdn)}/vhost.conf`), "utf8");
  const order = () => calls.map(({ op }) => op).filter((op) => ["site.write", "service.set", "ftp.setSuspended", "db.setLocked"].includes(op));
  const prepare = async () => {
    await runJob("/accounts/acme/databases", { name: "tienda" });
    await runJob("/accounts/acme/services/redis", { enabled: true, memoryMb: 128 });
    calls = [];
  };

  test("shows the 503, stops what is running and blocks FTP and MySQL, in that order", async () => {
    await prepare();
    const job = await runJob("/accounts/acme/suspend", { suspended: true });
    expect(job.status).toBe("succeeded");
    expect((await account()).suspended).toBe(true);
    expect(conf()).toContain("RewriteRule ^ - [R=503,L]");
    expect(order()).toEqual(["site.write", "service.set", "ftp.setSuspended", "db.setLocked"]);
    expect(callsTo("service.set")).toEqual([{ username: "acme", service: "redis", enabled: false, memoryMb: 128 }]);
    expect(callsTo("ftp.setSuspended")).toEqual([{ username: "acme", suspended: true }]);
    expect(callsTo("db.setLocked")).toEqual([{ databases: ["acme_tienda"], locked: true }]);
    expect(callsTo("php.restart")).toEqual([{ username: "acme" }]);
  });

  test("deletes nothing: databases, preferences and environments stay in the panel", async () => {
    await prepare();
    await runJob("/accounts/acme/suspend", { suspended: true });
    const after = await account();
    expect(after.databases).toEqual([{ name: "acme_tienda", sizeBytes: 0 }]);
    expect(after.services.redis).toMatchObject({ enabled: true, memoryMb: 128 });
    expect(after.vhosts[0]?.docRoot).toBe("sites/examplecom/public_html");
    expect(callsTo("db.delete")).toEqual([]);
    expect(callsTo("site.remove")).toEqual([]);
  });

  test("reactivating reverses the order: the site comes back with everything ready", async () => {
    await prepare();
    await runJob("/accounts/acme/suspend", { suspended: true });
    calls = [];
    const job = await runJob("/accounts/acme/suspend", { suspended: false });
    expect(job.status).toBe("succeeded");
    expect(order()).toEqual(["db.setLocked", "ftp.setSuspended", "service.set", "site.write"]);
    expect(callsTo("service.set")).toEqual([{ username: "acme", service: "redis", enabled: true, memoryMb: 128 }]);
    expect((await account()).suspended).toBe(false);
    expect(conf()).toContain("/home/acme/sites/examplecom/public_html");
    expect(conf()).not.toContain("R=503");
  });

  test("only reactivates what was active", async () => {
    await runJob("/accounts/acme/suspend", { suspended: true });
    await runJob("/accounts/acme/suspend", { suspended: false });
    expect(callsTo("service.set")).toEqual([]);
  });

  test("if it fails halfway, it leaves everything as it was", async () => {
    await prepare();
    failOn = "db.setLocked";
    const job = await runJob("/accounts/acme/suspend", { suspended: true });
    expect(job.status).toBe("rolled_back");
    expect((await account()).suspended).toBe(false);
    expect(conf()).not.toContain("R=503");
    expect(callsTo("ftp.setSuspended").at(-1)).toEqual({ username: "acme", suspended: false });
    expect(callsTo("service.set").at(-1)).toEqual({ username: "acme", service: "redis", enabled: true, memoryMb: 128 });
  });

  test("while suspended, nothing can publish the site again", async () => {
    await runJob("/accounts/acme/suspend", { suspended: true });
    const saved = await runJob(`/vhosts/${await vid("example.com")}/options`, { docRoot: "public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, logLevel: "WARN", logDays: 14 });
    expect(saved.status).toBe("succeeded");
    expect(conf()).toContain("R=503");
    await runJob(`/vhosts/${await vid("example.com")}/php`, { phpVersion: "84" });
    expect(conf()).toContain("R=503");
    await addEnvironment(runJob, "acme", "blog.example.com");
    expect(conf("blog.example.com")).toContain("R=503");
    expect(conf("blog.example.com")).not.toContain("extprocessor");
  });

  test("what was saved while suspended is applied on reactivation", async () => {
    await runJob("/accounts/acme/suspend", { suspended: true });
    await runJob(`/vhosts/${await vid("example.com")}/options`, { docRoot: "public_html", phpVersion: "85", phpOptions: { ...DEFAULT_PHP_OPTIONS, children: 9 }, logLevel: "ERROR", logDays: 30 });
    await runJob("/accounts/acme/suspend", { suspended: false });
    expect(conf()).toContain("PHP_LSAPI_CHILDREN=9");
  });

  test("while suspended it does not create databases or start services", async () => {
    await runJob("/accounts/acme/suspend", { suspended: true });
    expect((await post("/accounts/acme/databases", { name: "nueva" })).status).toBe(409);
    expect((await post("/accounts/acme/services/redis", { enabled: true, memoryMb: 64 })).status).toBe(409);
  });

  test("does not affect other accounts", async () => {
    await createSiteAccount(runJob, { username: "otra", domain: "otra.com", limits: DEFAULT_LIMITS });
    await runJob("/accounts/acme/suspend", { suspended: true });
    expect((await account("otra")).suspended).toBe(false);
    expect(conf("otra.com")).not.toContain("R=503");
  });

  test("repeating the same state touches nothing, and it can be deleted while suspended", async () => {
    expect((await post("/accounts/acme/suspend", { suspended: false })).status).toBe(409);
    await runJob("/accounts/acme/suspend", { suspended: true });
    expect((await post("/accounts/acme/suspend", { suspended: true })).status).toBe(409);
    expect((await runJob("/accounts/acme/delete", { confirm: "acme" })).status).toBe("succeeded");
  });

  test("an unknown account does not reach the agent", async () => {
    expect((await post("/accounts/nadie/suspend", { suspended: true })).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("restart PHP", () => {
  test("saving options restarts PHP: OLS does not", async () => {
    const job = await runJob(`/vhosts/${await vid("example.com")}/options`, { docRoot: "public_html", phpVersion: "85", phpOptions: { ...DEFAULT_PHP_OPTIONS, children: 2 }, logLevel: "ERROR", logDays: 30 });
    expect(job.status).toBe("succeeded");
    expect(callsTo("php.restart")).toEqual([{ username: "acme" }]);
  });

  test("also when changing the version", async () => {
    const job = await runJob(`/vhosts/${await vid("example.com")}/php`, { phpVersion: "84" });
    expect(job.status).toBe("succeeded");
    expect(callsTo("php.restart")).toEqual([{ username: "acme" }]);
  });

  test("if the restart fails, the options are undone", async () => {
    failOn = "php.restart";
    const job = await runJob(`/vhosts/${await vid("example.com")}/options`, { docRoot: "public_html", phpVersion: "85", phpOptions: { ...DEFAULT_PHP_OPTIONS, children: 2 }, logLevel: "ERROR", logDays: 30 });
    expect(job.status).toBe("rolled_back");
    expect((await account()).vhosts[0]?.phpOptions.children).toBe(5);
  });

  test("can be restarted on demand, without touching OLS", async () => {
    const job = await runJob("/accounts/acme/php/restart");
    expect(job.status).toBe("succeeded");
    expect(callsTo("php.restart")).toEqual([{ username: "acme" }]);
    expect(callsTo("ols.sync")).toEqual([]);
  });

  test("an unknown account does not reach the agent", async () => {
    expect((await post("/accounts/otra/php/restart")).status).toBe(404);
    expect(callsTo("php.restart")).toEqual([]);
  });
});

describe("environment logs", () => {
  const logs = async (query: string, fqdn = "example.com") => app.request(`/api/vhosts/${fqdn === "other.com" ? 999 : await vid(fqdn)}/logs${query}`, { headers: { cookie } });

  test("asks the agent for that environment log, for its account", async () => {
    const response = await logs("?source=php&lines=20");
    expect(response.status).toBe(200);
    expect(callsTo("logs.read")).toEqual([{ username: "acme", site: "examplecom", source: "php", lines: 20 }]);
  });

  test("returns 200 lines by default", async () => {
    await logs("?source=access");
    expect(callsTo("logs.read")).toEqual([{ username: "acme", site: "examplecom", source: "access", lines: 200 }]);
  });

  test("an unknown environment does not reach the agent", async () => {
    expect((await logs("?source=access", "other.com")).status).toBe(404);
    expect(callsTo("logs.read")).toEqual([]);
  });

  test.each([["?source=shadow"], ["?source=access&lines=100000"], ["?source=access&lines=abc"], [""]])("rejects the query %s", async (query) => {
    expect((await logs(query)).status).toBe(400);
    expect(callsTo("logs.read")).toEqual([]);
  });

  test("requires a session", async () => {
    expect((await app.request("/api/vhosts/1/logs?source=access")).status).toBe(401);
  });

  test("reports the agent error without crashing", async () => {
    failOn = "logs.read";
    const response = await logs("?source=php");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "simulated failure in logs.read" });
  });

  test("level and days are stored and reach the vhost and logrotate", async () => {
    const job = await runJob(`/vhosts/${await vid("example.com")}/options`, { docRoot: "public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, logLevel: "WARN", logDays: 14 });
    expect(job.status).toBe("succeeded");
    expect((await account()).vhosts[0]).toMatchObject({ logLevel: "WARN", logDays: 14 });
    expect(readFileSync(host.resolvePath("/usr/local/lsws/conf/vhosts/examplecom/vhost.conf"), "utf8")).toContain("logLevel                WARN");
    expect(readFileSync(host.resolvePath("/etc/logrotate.d/eaglepanel-examplecom.conf"), "utf8")).toContain("rotate 14");
  });

  test.each([[{ logLevel: "TODO", logDays: 14 }], [{ logLevel: "WARN", logDays: 0 }], [{ logLevel: "WARN", logDays: 1000 }]])("rejects invalid values %j", async (values) => {
    const response = await post(`/vhosts/${await vid("example.com")}/options`, { docRoot: "public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, ...values });
    expect(response.status).toBe(400);
  });
});

describe("environment options", () => {
  const options = { ...DEFAULT_PHP_OPTIONS, children: 8, directives: { ...DEFAULT_PHP_OPTIONS.directives, memory_limit: "128M" } };
  const vhostFile = () => readFileSync(host.resolvePath("/usr/local/lsws/conf/vhosts/examplecom/vhost.conf"), "utf8");

  test("a new environment starts with the default options", async () => {
    expect((await account()).vhosts[0]?.phpOptions).toEqual(DEFAULT_PHP_OPTIONS);
  });

  test("stores, writes the vhost and restarts OLS", async () => {
    const job = await runJob(`/vhosts/${await vid("example.com")}/options`, { docRoot: "public_html/web", phpVersion: "85", phpOptions: options, logLevel: "WARN", logDays: 14 });
    expect(job.status).toBe("succeeded");
    const vhost = (await account()).vhosts[0];
    expect(vhost?.docRoot).toBe("public_html/web");
    expect(vhost?.phpOptions.children).toBe(8);
    expect(vhostFile()).toContain("PHP_LSAPI_CHILDREN=8");
    expect(vhostFile()).toContain("/home/acme/public_html/web");
    expect(callsTo("ols.sync").at(-1)).toMatchObject({ restart: true });
  });

  test("if OLS fails, it restores the previous state", async () => {
    failOn = "ols.sync";
    const job = await runJob(`/vhosts/${await vid("example.com")}/options`, { docRoot: "public_html", phpVersion: "85", phpOptions: options, logLevel: "ERROR", logDays: 30 });
    expect(job.status).toBe("rolled_back");
    expect((await account()).vhosts[0]?.phpOptions).toEqual(DEFAULT_PHP_OPTIONS);
    expect(vhostFile()).toContain("PHP_LSAPI_CHILDREN=5");
  });

  test.each([["tmp"], ["tmp/sesiones"], ["data"], ["logs"], ["run"]])("does not publish the private directory %s", async (docRoot) => {
    expect((await post(`/vhosts/${await vid("example.com")}/options`, { docRoot, phpVersion: "85", phpOptions: options, logLevel: "ERROR", logDays: 30 })).status).toBe(400);
  });

  test.each([["../otra"], ["/etc"], ["a/../../b"], [".."]])("rejects the directory %s", async (docRoot) => {
    expect((await post(`/vhosts/${await vid("example.com")}/options`, { docRoot, phpVersion: "85", phpOptions: options, logLevel: "ERROR", logDays: 30 })).status).toBe(400);
  });

  test("rejects a security directive sent as an option", async () => {
    const response = await post(`/vhosts/${await vid("example.com")}/options`, {
      docRoot: "public_html",
      phpVersion: "85",
      phpOptions: { ...options, directives: { ...options.directives, open_basedir: "/" } },
      logLevel: "ERROR",
      logDays: 30,
    });
    expect(response.status).toBe(400);
  });
});
