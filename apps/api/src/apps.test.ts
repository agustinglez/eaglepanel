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
import { createSiteAccount, addEnvironment, testSlug } from "./test-support";
import { hashPassword, setAdminCredentials } from "./auth";
import { openDb, type Db } from "./db";
import { apps, auditLog, deployments, deployQueue, jobSteps, vhosts } from "./db/schema";
import { eq } from "drizzle-orm";
import { JobRunner } from "./jobs";

const PASSWORD = "test-password-value";
const passwordHash = await hashPassword(PASSWORD);

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
let calls: { op: AgentOpName; params: unknown }[];
let failOn: AgentOpName | null;
/** Simulated responses per operation: the sandbox does not build or start anything. */
let overrides: Partial<Record<AgentOpName, (params: never) => unknown>>;

const agent: AgentClient = {
  call: (async (op: AgentOpName, params: unknown) => {
    calls.push({ op, params });
    if (op === "php.versions") return { versions: ["85", "84"] };
    const override = overrides[op];
    if (override) return override(params as never);
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
const get = (path: string) => app.request(`/api${path}`, { headers: { cookie } });
const account = async () => (await (await get("/accounts/acme")).json()) as AccountDto;

async function waitFor(jobId: string): Promise<JobDto> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const job = jobs.get(jobId);
    if (job && job.status !== "pending" && job.status !== "running") return job;
    await Bun.sleep(5);
  }
  throw new Error("The job did not finish");
}

async function runJob(path: string, body: unknown = {}): Promise<JobDto> {
  const response = await post(path, body);
  expect(response.status).toBe(202);
  const { jobId } = (await response.json()) as { jobId: string };
  return waitFor(jobId);
}

const callsTo = (op: AgentOpName) => calls.filter((entry) => entry.op === op).map((entry) => entry.params);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "eaglepanel-apps-"));
  roots.push(root);
  host = new SandboxHost(root);
  calls = [];
  failOn = null;
  overrides = {};
  db = openDb(":memory:");
  setAdminCredentials(db, "admin", passwordHash);
  jobs = new JobRunner(db);
  app = createApp({ db, agent, jobs });
  await host.writeFileAtomic(HTTPD_CONFIG, "serverName test\n");
  const login = await post("/auth/login", { username: "admin", password: PASSWORD }, "");
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const created = await createSiteAccount(runJob, { username: "acme", domain: "example.com", limits: { ...DEFAULT_LIMITS, quotaMb: 500, appMemoryMb: 512 } });
  expect(created.status).toBe("succeeded");
  calls = [];
});

const CONFIG = {
  kind: "server",
  repoUrl: "https://github.com/acme/api.git",
  branch: "main",
  subdir: "",
  runtime: "bun",
  runtimeVersion: "1",
  buildCommand: "bun install --frozen-lockfile && bun --bun run build",
  startCommand: "bun --bun run start",
  outputDir: "",
  spaFallback: true,
  healthPath: "/health",
  memoryMb: 256,
} as const;
const conf = (fqdn = "api.example.com") => readFileSync(host.resolvePath(`/usr/local/lsws/conf/vhosts/${testSlug(fqdn)}/vhost.conf`), "utf8");
const vhostOf = async (fqdn = "api.example.com") => (await account()).vhosts.find((item) => item.hostname === fqdn);
type DeploymentRow = { id: number; release: number; status: string; active: boolean; available: boolean };
const deploymentsOf = async (fqdn = "api.example.com") => (await (await get(`/vhosts/${await vid(fqdn)}/deployments`)).json()) as DeploymentRow[];

async function newApp(config: Record<string, unknown> = CONFIG, fqdn = "api.example.com") {
  expect((await addEnvironment(runJob, "acme", fqdn)).status).toBe("succeeded");
  const job = await runJob(`/vhosts/${await vid(fqdn)}/app`, config);
  if (job.status !== "succeeded") console.log("ERROR", job.error, JSON.stringify(job.steps.map((s) => [s.name, s.status, s.error])));
  expect(job.status).toBe("succeeded");
  calls = [];
}

describe("convert to app", () => {
  test("an app has no FTP access of its own: converting removes it, and it cannot be created", async () => {
    expect((await addEnvironment(runJob, "acme", "api.example.com")).status).toBe("succeeded");
    expect((await runJob(`/vhosts/${await vid("api.example.com")}/ftp/password`, {})).status).toBe("succeeded");
    expect((await runJob(`/vhosts/${await vid("api.example.com")}/app`, CONFIG)).status).toBe("succeeded");
    expect(calls.some(({ op }) => op === "ftp.removeSite")).toBe(true);
    expect((await vhostOf())?.ftp).toBeNull();
    expect((await post(`/vhosts/${await vid("api.example.com")}/ftp/password`, {})).status).toBe(409);
  });

  test("switches to proxy, stores the configuration and prepares the network", async () => {
    await newApp();
    const vhost = await vhostOf();
    expect(vhost?.type).toBe("app");
    expect(vhost?.app).toMatchObject({ config: CONFIG, status: "new", currentRelease: null, env: [] });
    expect(conf()).toContain("type                    proxy");
    expect(conf()).toContain("websocket / {");
    expect(conf()).not.toContain("lsphp");
  });

  test("each app gets its own network", async () => {
    await newApp();
    await newApp({ ...CONFIG, memoryMb: 128 }, "web.example.com");
    expect(conf()).toContain("10.88.0.6:3000");
    expect(conf("web.example.com")).toContain("10.88.0.10:3000");
  });

  test("respects the account app memory", async () => {
    await newApp();
    await addEnvironment(runJob, "acme", "web.example.com");
    const response = await post(`/vhosts/${await vid("web.example.com")}/app`, { ...CONFIG, memoryMb: 512 });
    expect(response.status).toBe(409);
    expect((await vhostOf("web.example.com"))?.type).toBe("php");
  });

  test("if preparation fails, the environment goes back to PHP", async () => {
    await addEnvironment(runJob, "acme", "api.example.com");
    failOn = "app.prepare";
    const job = await runJob(`/vhosts/${await vid("api.example.com")}/app`, CONFIG);
    expect(job.status).toBe("rolled_back");
    const vhost = await vhostOf();
    expect(vhost?.type).toBe("php");
    expect(vhost?.app).toBeNull();
    expect(conf()).toContain("lsphp");
  });

  test.each([
    [{ runtime: "node", runtimeVersion: "24" }], [{ repoUrl: "file:///etc" }], [{ branch: "--upload-pack=id" }], [{ startCommand: "" }], [{ runtime: "bun", runtimeVersion: "24" }], [{ buildCommand: "a\nb" }], [{ kind: "worker" }], [{ memoryMb: 0 }],
  ])("rejects %j", async (change) => {
    await addEnvironment(runJob, "acme", "api.example.com");
    expect((await post(`/vhosts/${await vid("api.example.com")}/app`, { ...CONFIG, ...change })).status).toBe(400);
  });

  test("PHP options are not applied to an app", async () => {
    await newApp();
    expect((await post(`/vhosts/${await vid("api.example.com")}/options`, { docRoot: "public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, logLevel: "ERROR", logDays: 30 })).status).toBe(400);
  });
});

describe("deploy", () => {
  test("fetches, builds, creates the image, starts and publishes, in that order", async () => {
    await newApp();
    const job = await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    expect(job.status).toBe("succeeded");
    expect(job.steps.map(({ name }) => name)).toEqual([
      "Register the deployment", "Prepare the image and the variables", "Fetch the code", "Build", "Build the release image", "Start and check that it responds", "Keep the last 3 releases",
    ]);
    expect((callsTo("app.build") as { command: string }[]).map(({ command }) => command)).toEqual([CONFIG.buildCommand]);
    expect(callsTo("app.release")).toEqual([expect.objectContaining({ kind: "server", release: 1 })]);
    expect((await vhostOf())?.app).toMatchObject({ status: "online", currentRelease: 1 });
    expect(await deploymentsOf()).toMatchObject([{ release: 1, status: "succeeded", active: true, available: true }]);
  });

  test("without a build command, it does not run one", async () => {
    await newApp({ ...CONFIG, buildCommand: "" });
    const job = await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    expect(job.steps.map(({ name }) => name)).not.toContain("Build");
  });

  test("each deployment is a new release, and the last three are kept", async () => {
    await newApp();
    for (let index = 0; index < 4; index += 1) expect((await runJob(`/vhosts/${await vid("api.example.com")}/deploy`)).status).toBe("succeeded");
    expect([...(callsTo("app.prune").at(-1) as { keep: number[] }).keep].sort()).toEqual([2, 3, 4]);
    const list = await deploymentsOf();
    expect(list.map(({ release }) => release)).toEqual([4, 3, 2, 1]);
    expect(list.find(({ release }) => release === 1)?.available).toBe(false);
  });

  test("if the build fails, it stores the log, marks the failure and does not touch the active release", async () => {
    await newApp();
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    calls = [];
    overrides["app.build"] = (() => ({ code: 2, log: "Error: does not compile\n" })) as never;
    const job = await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    expect(job.status).toBe("rolled_back");
    expect(job.error).toContain("The build exited with code 2");
    const failed = (await deploymentsOf())[0]!;
    expect(failed).toMatchObject({ release: 2, status: "failed" });
    const log = (await (await get(`/vhosts/${await vid("api.example.com")}/deployments/${failed.id}/log`)).json()) as { log: string };
    expect(log.log).toContain("Error: does not compile");
    expect((await vhostOf())?.app).toMatchObject({ status: "online", currentRelease: 1 });
    expect(callsTo("app.activate")).toEqual([]);
    expect(callsTo("app.release")).toEqual([]);
  });

  test("if the new release does not respond, it rolls back to the previous one", async () => {
    await newApp();
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    calls = [];
    overrides["app.activate"] = ((params: { release: number }) => ({ healthy: params.release === 1, log: params.release === 1 ? "" : "Error: crash\n" })) as never;
    const job = await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    expect(job.status).toBe("rolled_back");
    expect((callsTo("app.activate") as { release: number }[]).map(({ release }) => release)).toEqual([2, 1]);
    expect((await vhostOf())?.app).toMatchObject({ status: "online", currentRelease: 1 });
  });

  test("if the first deployment does not respond, it stays stopped and failing", async () => {
    await newApp();
    overrides["app.activate"] = (() => ({ healthy: false, log: "Error\n" })) as never;
    const job = await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    expect(job.status).toBe("rolled_back");
    expect(callsTo("app.control")).toEqual([{ appId: expect.any(Number), action: "stop" }]);
    expect((await vhostOf())?.app).toMatchObject({ status: "failed", currentRelease: null });
  });

  test("over SSH, the deploy key is required first", async () => {
    await newApp({ ...CONFIG, repoUrl: "git@github.com:acme/api.git" });
    expect((await post(`/vhosts/${await vid("api.example.com")}/deploy`)).status).toBe(409);
    const key = (await (await post(`/vhosts/${await vid("api.example.com")}/app/deploy-key`)).json()) as { publicKey: string };
    expect(key.publicKey).toStartWith("ssh-ed25519 ");
    expect((await vhostOf())?.app?.deployKey).toBe(key.publicKey);
    expect((await runJob(`/vhosts/${await vid("api.example.com")}/deploy`)).status).toBe("succeeded");
  });

  test("a deployment requested while another is running is queued, can be cancelled, and starts when the previous one ends", async () => {
    await newApp();
    const first = (await (await post(`/vhosts/${await vid("api.example.com")}/deploy`)).json()) as { jobId: string; position: number };
    expect(first.position).toBe(0);
    const second = await post(`/vhosts/${await vid("api.example.com")}/deploy`);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ jobId: null, position: 1 });
    expect(await (await post(`/vhosts/${await vid("api.example.com")}/deploy`)).json()).toEqual({ jobId: null, position: 2 });

    const queue = (await vhostOf())!.app!.queue;
    expect(queue.map(({ trigger, commit }) => [trigger, commit])).toEqual([["from the panel", null], ["from the panel", null]]);
    expect((await post(`/vhosts/${await vid("api.example.com")}/queue/${queue[1]!.id}/cancel`)).status).toBe(200);
    expect((await post(`/vhosts/${await vid("api.example.com")}/queue/${queue[1]!.id}/cancel`)).status).toBe(404);

    expect((await waitFor(first.jobId)).status).toBe("succeeded");
    for (let attempt = 0; attempt < 600 && (await vhostOf())!.app!.currentRelease !== 2; attempt += 1) await Bun.sleep(5);
    const after = (await vhostOf())!.app!;
    expect(after).toMatchObject({ currentRelease: 2, queue: [] });
    for (let attempt = 0; attempt < 600 && (await vhostOf())!.app!.status === "deploying"; attempt += 1) await Bun.sleep(5);
    expect(db.select().from(deployments).all().map(({ release }) => release)).toEqual([1, 2]);
  });

  test("if an older queued one starts, the new request reports its position in the queue", async () => {
    await newApp();
    db.insert(deployQueue).values({ vhost: await vid("api.example.com"), trigger: "webhook de GitHub, main ccccccc", commit: "c".repeat(40), requestedAt: Date.now() }).run();
    expect(await (await post(`/vhosts/${await vid("api.example.com")}/deploy`)).json()).toEqual({ jobId: null, position: 1 });
    for (let attempt = 0; attempt < 600 && db.select().from(deployments).all().filter(({ status }) => status === "succeeded").length < 2; attempt += 1) await Bun.sleep(5);
    expect(db.select().from(deployments).all().map(({ release, commit }) => [release, commit])).toEqual([[1, "c".repeat(40)], [2, "0".repeat(40)]]);
  });

  test("does not deploy a PHP environment or a suspended account", async () => {
    await addEnvironment(runJob, "acme", "blog.example.com");
    expect((await post(`/vhosts/${await vid("blog.example.com")}/deploy`)).status).toBe(400);
    await newApp();
    await runJob("/accounts/acme/suspend", { suspended: true });
    expect((await post(`/vhosts/${await vid("api.example.com")}/deploy`)).status).toBe(409);
  });
});

describe("variables", () => {
  test("separates runtime and build variables, and stores no values in the audit log", async () => {
    await newApp();
    const job = await runJob(`/vhosts/${await vid("api.example.com")}/env`, { vars: [
      { key: "SECRET", value: "valor-secreto-123", scope: "runtime" },
      { key: "NEXT_PUBLIC_API", value: "https://api", scope: "build" },
      { key: "SHARED", value: "x", scope: "both" },
    ] });
    expect(job.status).toBe("succeeded");
    expect(callsTo("app.env").at(-1)).toEqual({ appId: expect.any(Number), runtime: { SECRET: "valor-secreto-123", SHARED: "x" }, build: { NEXT_PUBLIC_API: "https://api", SHARED: "x" } });
    const persisted = JSON.stringify([db.select().from(auditLog).all(), db.select().from(jobSteps).all()]);
    expect(persisted).not.toContain("valor-secreto-123");
    expect(persisted).toContain("SECRET");
    expect((await vhostOf())?.app?.env).toHaveLength(3);
  });

  test.each([[{ key: "PORT", value: "1", scope: "runtime" }], [{ key: "lower", value: "1", scope: "runtime" }], [{ key: "A", value: "1", scope: "other" }]])("rejects %j", async (variable) => {
    await newApp();
    expect((await post(`/vhosts/${await vid("api.example.com")}/env`, { vars: [variable] })).status).toBe(400);
  });

  test("rejects duplicate keys", async () => {
    await newApp();
    expect((await post(`/vhosts/${await vid("api.example.com")}/env`, { vars: [{ key: "A", value: "1", scope: "runtime" }, { key: "A", value: "2", scope: "build" }] })).status).toBe(400);
  });
});

describe("operar", () => {
  test("rolls back to a kept release without building", async () => {
    await newApp();
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    calls = [];
    const first = (await deploymentsOf()).find(({ release }) => release === 1)!;
    const job = await runJob(`/vhosts/${await vid("api.example.com")}/deployments/${first.id}/rollback`);
    expect(job.status).toBe("succeeded");
    expect(callsTo("app.build")).toEqual([]);
    expect((await vhostOf())?.app?.currentRelease).toBe(1);
  });

  test("does not roll back to the release that is already active", async () => {
    await newApp();
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    const active = (await deploymentsOf())[0]!;
    expect((await post(`/vhosts/${await vid("api.example.com")}/deployments/${active.id}/rollback`)).status).toBe(409);
  });

  test("stop and start update the status", async () => {
    await newApp();
    expect((await post(`/vhosts/${await vid("api.example.com")}/app/stop`)).status).toBe(409);
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    await runJob(`/vhosts/${await vid("api.example.com")}/app/stop`);
    expect((await vhostOf())?.app?.status).toBe("stopped");
    await runJob(`/vhosts/${await vid("api.example.com")}/app/start`);
    expect((await vhostOf())?.app?.status).toBe("online");
    expect((await post(`/vhosts/${await vid("api.example.com")}/app/borrar`)).status).toBe(404);
  });

  test("suspending stops the online app, and reactivating starts it again", async () => {
    await newApp();
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    calls = [];
    await runJob("/accounts/acme/suspend", { suspended: true });
    expect(callsTo("app.control")).toEqual([{ appId: expect.any(Number), action: "stop" }]);
    expect(conf()).toContain("R=503");
    calls = [];
    await runJob("/accounts/acme/suspend", { suspended: false });
    expect(callsTo("app.control")).toEqual([{ appId: expect.any(Number), action: "start" }]);
    expect(conf()).toContain("websocket / {");
  });

  test("switching to PHP deletes the app and publishes PHP again", async () => {
    await newApp();
    const job = await runJob(`/vhosts/${await vid("api.example.com")}/to-php`);
    expect(job.status).toBe("succeeded");
    expect(callsTo("app.remove")).toHaveLength(1);
    expect(await vhostOf()).toMatchObject({ type: "php", app: null });
    expect(conf()).toContain("lsphp");
  });

  test("deleting the environment deletes the app", async () => {
    await newApp();
    expect((await runJob(`/vhosts/${await vid("api.example.com")}/delete`)).status).toBe("succeeded");
    expect(callsTo("app.remove")).toHaveLength(1);
  });

  test("deleting the account deletes its apps", async () => {
    await newApp();
    expect((await runJob("/accounts/acme/delete", { confirm: "acme" })).status).toBe("succeeded");
    expect(callsTo("app.remove")).toHaveLength(1);
  });

  test("status and logs come from the agent; a PHP environment has none", async () => {
    await newApp();
    expect((await get(`/vhosts/${await vid("api.example.com")}/app/status`)).status).toBe(200);
    expect((await get(`/vhosts/${await vid("api.example.com")}/app/logs?lines=50`)).status).toBe(200);
    expect(callsTo("app.logs")).toEqual([{ appId: expect.any(Number), lines: 50, sinceMs: expect.any(Number) }]);
    expect((await get(`/vhosts/${await vid("example.com")}/app/logs`)).status).toBe(400);
  });
});

const STATIC = { ...CONFIG, kind: "static", startCommand: "", outputDir: "dist", memoryMb: 0 } as const;
/** Releases live under the app id, not under the environment: renaming it moves nothing. */
const appIdOf = (hostname: string) => db.select({ id: apps.id }).from(apps).innerJoin(vhosts, eq(vhosts.id, apps.vhost)).where(eq(vhosts.hostname, hostname)).get()!.id;
const RELEASE = (release: number) => `/srv/eaglepanel/apps/acme/${appIdOf("api.example.com")}/releases/${release}`;

describe("static sites", () => {
  test("until the first deployment OLS answers 503, without a process or PHP", async () => {
    await newApp(STATIC);
    expect((await vhostOf())?.app).toMatchObject({ config: STATIC, status: "new" });
    expect(conf()).toContain("R=503");
    expect(conf()).not.toContain("extprocessor");
  });

  test("they reserve no account memory", async () => {
    await newApp({ ...CONFIG, memoryMb: 512 });
    await newApp(STATIC, "web.example.com");
    expect((await vhostOf("web.example.com"))?.type).toBe("app");
  });

  test("deploying builds, stores the published files and OLS serves that release, without starting anything", async () => {
    await newApp(STATIC);
    const job = await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    expect(job.status).toBe("succeeded");
    expect(job.steps.map(({ name }) => name)).toEqual([
      "Register the deployment", "Prepare the image and the variables", "Fetch the code", "Build", "Save the published files", "Publish the release", "Keep the last 3 releases",
    ]);
    expect(callsTo("app.release")).toEqual([expect.objectContaining({ kind: "static", outputDir: "dist", release: 1 })]);
    expect(callsTo("app.activate")).toEqual([]);
    expect(conf()).toContain(`docRoot                   ${RELEASE(1)}`);
    expect(conf()).toContain("RewriteRule ^ /index.html [L]");
    expect((await vhostOf())?.app).toMatchObject({ status: "online", currentRelease: 1 });
  });

  test("if publishing fails, OLS keeps serving the previous release", async () => {
    await newApp(STATIC);
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    failOn = "ols.sync";
    const job = await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    expect(job.status).toBe("rolled_back");
    expect(conf()).toContain(`docRoot                   ${RELEASE(1)}`);
    expect((await vhostOf())?.app).toMatchObject({ status: "online", currentRelease: 1 });
  });

  test("rolling back to a release publishes it again, without building", async () => {
    await newApp(STATIC);
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    expect(conf()).toContain(`docRoot                   ${RELEASE(2)}`);
    calls = [];
    const first = (await deploymentsOf()).find(({ release }) => release === 1)!;
    expect((await runJob(`/vhosts/${await vid("api.example.com")}/deployments/${first.id}/rollback`)).status).toBe("succeeded");
    expect(conf()).toContain(`docRoot                   ${RELEASE(1)}`);
    expect(callsTo("app.build")).toEqual([]);
  });

  test("they have no process: no start, no status and no app logs", async () => {
    await newApp(STATIC);
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    expect((await post(`/vhosts/${await vid("api.example.com")}/app/restart`)).status).toBe(409);
    expect((await get(`/vhosts/${await vid("api.example.com")}/app/status`)).status).toBe(409);
    expect((await get(`/vhosts/${await vid("api.example.com")}/app/logs`)).status).toBe(409);
  });

  test("suspending touches no processes, it only shows the 503", async () => {
    await newApp(STATIC);
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    calls = [];
    await runJob("/accounts/acme/suspend", { suspended: true });
    expect(callsTo("app.control")).toEqual([]);
    expect(conf()).toContain("R=503");
    await runJob("/accounts/acme/suspend", { suspended: false });
    expect(conf()).toContain(`docRoot                   ${RELEASE(1)}`);
  });

  test("switching from server to static stops the process and stops offering its releases", async () => {
    await newApp();
    await runJob(`/vhosts/${await vid("api.example.com")}/deploy`);
    calls = [];
    const job = await runJob(`/vhosts/${await vid("api.example.com")}/app`, STATIC);
    expect(job.status).toBe("succeeded");
    expect(callsTo("app.control")).toEqual([{ appId: expect.any(Number), action: "stop" }]);
    expect(callsTo("app.prune")).toEqual([expect.objectContaining({ keep: [] })]);
    expect((await vhostOf())?.app).toMatchObject({ status: "new", currentRelease: null });
    expect(conf()).toContain("R=503");
    expect((await deploymentsOf()).map(({ available }) => available)).toEqual([false]);
  });
});
