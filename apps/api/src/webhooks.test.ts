import { DEFAULT_LIMITS, type AccountDto, type AgentOpName, type JobDto, type VhostDto } from "@eaglepanel/shared";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../agent/src/dispatch";
import { SandboxHost } from "../../agent/src/host";
import { HTTPD_CONFIG, PANEL_CONF_DIR } from "../../agent/src/ols";
import type { AgentClient } from "./agent-client";
import { createApp } from "./app";
import { hashPassword, setAdminCredentials } from "./auth";
import { openDb, type Db } from "./db";
import { eq } from "drizzle-orm";
import { accounts, apps, certificates, deployments, deployQueue } from "./db/schema";
import { JobRunner } from "./jobs";
import { addEnvironment, createSiteAccount, testSlug } from "./test-support";
import { normalizeRepo, validSignature } from "./webhooks";

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
let calls: { op: AgentOpName; params: unknown }[];

const agent: AgentClient = {
  call: (async (op: AgentOpName, params: unknown) => {
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
  for (const item of (await response.json()) as AccountDto[]) {
    const found = item.vhosts.find((vhost) => vhost.hostname === hostname);
    if (found) return found.id;
  }
  throw new Error(`No environment answers for ${hostname}`);
}

const post = (path: string, body: unknown = {}) => app.request(`/api${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-eaglepanel": "1", cookie }, body: JSON.stringify(body),
});
const get = (path: string) => app.request(`/api${path}`, { headers: { cookie } });

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
  return waitFor(((await response.json()) as { jobId: string }).jobId);
}
const vhostOf = async (username: string, fqdn: string) =>
  ((await (await get(`/accounts/${username}`)).json()) as AccountDto).vhosts.find((item) => item.hostname === fqdn) as VhostDto;
/** By hostname for an environment; the webhook vhost has its own name. */
const conf = (name: string) => readFileSync(host.resolvePath(`/usr/local/lsws/conf/vhosts/${name.includes(".") ? testSlug(name) : name}/vhost.conf`), "utf8");

const CONFIG = {
  kind: "static", repoUrl: "git@github.com:Acme/Front.git", branch: "main", subdir: "", runtime: "bun", runtimeVersion: "1",
  buildCommand: "bun install && bun run build", startCommand: "", outputDir: "dist", spaFallback: true, healthPath: "/", memoryMb: 0,
} as const;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "eaglepanel-hooks-"));
  roots.push(root);
  host = new SandboxHost(root);
  calls = [];
  db = openDb(":memory:");
  setAdminCredentials(db, "admin", passwordHash);
  jobs = new JobRunner(db);
  app = createApp({ db, agent, jobs });
  await host.writeFileAtomic(HTTPD_CONFIG, "serverName test\n");
  const login = await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json", "x-eaglepanel": "1" }, body: JSON.stringify({ username: "admin", password: PASSWORD }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  for (const [username, domain] of [["acme", "example.com"], ["otra", "otra.com"]] as const) {
    expect((await createSiteAccount(runJob, { username, domain, limits: DEFAULT_LIMITS })).status).toBe("succeeded");
    db.insert(certificates).values({ zone: domain, username, names: [domain, `*.${domain}`], notAfter: Date.now() + 86_400_000 }).run();
  }
  expect((await addEnvironment(runJob, "acme", "web.example.com")).status).toBe("succeeded");
  expect((await runJob(`/vhosts/${await vid("web.example.com")}/app`, CONFIG)).status).toBe("succeeded");
  await post(`/vhosts/${await vid("web.example.com")}/app/deploy-key`);
  expect((await post(`/vhosts/${await vid("web.example.com")}/webhook`, { enabled: true })).status).toBe(200);
  calls = [];
});

const secretOf = async () => (await vhostOf("acme", "web.example.com")).app!.webhook.secret!;
const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
function push(hostName: string, path: string, body: string, signature: string, event = "push", contentType = "application/json") {
  return app.request(path, {
    method: "POST",
    headers: { host: hostName, "content-type": contentType, "x-github-event": event, "x-hub-signature-256": signature },
    body,
  });
}
const pushPayload = (ref = "refs/heads/main", repo = "https://github.com/acme/front", after = "a".repeat(40)) =>
  JSON.stringify({ ref, after, repository: { html_url: repo, clone_url: `${repo}.git` } });
const fetches = () => calls.filter(({ op }) => op === "app.fetch").map(({ params }) => (params as { commit?: string }).commit);
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 600 && !check(); attempt += 1) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe("piezas", () => {
  test("compares repositories regardless of HTTPS, SSH, .git or case", () => {
    for (const url of ["https://github.com/Acme/Front.git", "git@github.com:acme/front.git", "ssh://git@github.com/acme/front", "https://github.com/acme/front/"]) {
      expect(normalizeRepo(url)).toBe("github.com/acme/front");
    }
    expect(normalizeRepo("https://gitlab.com/acme/front")).not.toBe(normalizeRepo("https://github.com/acme/front"));
  });

  test("the signature must match the body byte by byte", () => {
    const body = new TextEncoder().encode('{"a":1}');
    expect(validSignature("s", body, sign("s", '{"a":1}'))).toBe(true);
    expect(validSignature("s", body, sign("s", '{"a": 1}'))).toBe(false);
    expect(validSignature("s", body, sign("other", '{"a":1}'))).toBe(false);
    expect(validSignature("s", body, undefined)).toBe(false);
  });
});

describe("server-wide domain", () => {
  beforeEach(async () => {
    expect((await runJob("/settings/server", { hooksDomain: "hooks.example.com" })).status).toBe("succeeded");
    calls = [];
  });

  test("OLS publishes only the webhook path on that domain, with the certificate that covers it", () => {
    const config = readFileSync(host.resolvePath(`${PANEL_CONF_DIR}/listeners.conf`), "utf8");
    expect(readFileSync(host.resolvePath(HTTPD_CONFIG), "utf8")).toContain(`include ${PANEL_CONF_DIR}/hooks.conf`);
    expect(config).toContain("map                     eaglepanel-hooks hooks.example.com");
    expect(conf("eaglepanel-hooks")).toContain("context /hooks/github {");
    expect(conf("eaglepanel-hooks")).toContain("/eaglepanel-certs/example.com/origin.crt");
  });

  test("a signed push to the app branch deploys it", async () => {
    const body = pushPayload();
    const response = await push("hooks.example.com", "/hooks/github", body, sign(await secretOf(), body));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ deployed: [await vid("web.example.com")], queued: [], skipped: [] });
    for (let attempt = 0; attempt < 400 && !calls.some(({ op }) => op === "app.release"); attempt += 1) await Bun.sleep(5);
    expect(calls.some(({ op }) => op === "app.build")).toBe(true);
  });

  test("a push while deploying is queued and its commit is deployed when the previous one ends", async () => {
    const secret = await secretOf();
    const first = pushPayload();
    const second = pushPayload(undefined, undefined, "b".repeat(40));
    expect(await (await push("hooks.example.com", "/hooks/github", first, sign(secret, first))).json()).toMatchObject({ deployed: [await vid("web.example.com")] });
    expect(await (await push("hooks.example.com", "/hooks/github", second, sign(secret, second))).json())
      .toEqual({ deployed: [], queued: [{ vhost: await vid("web.example.com"), position: 1 }], skipped: [] });
    expect((await vhostOf("acme", "web.example.com")).app!.queue).toMatchObject([{ commit: "b".repeat(40) }]);

    await until(() => fetches().length === 2);
    expect(fetches()).toEqual(["a".repeat(40), "b".repeat(40)]);
    await until(() => db.select().from(apps).get()?.status === "online");
    expect((await vhostOf("acme", "web.example.com")).app).toMatchObject({ queue: [], currentRelease: 2, commit: "b".repeat(40) });
  });

  test("when the panel restarts, the interrupted deployment is marked failed and the queue continues", async () => {
    db.update(apps).set({ status: "deploying" }).run();
    db.insert(deployments).values({ vhost: await vid("web.example.com"), release: 1, kind: "static", status: "running", startedAt: Date.now() }).run();
    db.insert(deployQueue).values({ vhost: await vid("web.example.com"), trigger: "webhook de GitHub, main ccccccc", commit: "c".repeat(40), requestedAt: Date.now() }).run();
    calls = [];
    app = createApp({ db, agent, jobs });

    expect(db.select().from(deployments).all()[0]).toMatchObject({ status: "failed" });
    await until(() => fetches().length === 1);
    expect(fetches()).toEqual(["c".repeat(40)]);
    await until(() => db.select().from(apps).get()?.status !== "deploying");
    expect(db.select().from(deployQueue).all()).toEqual([]);
    expect(db.select().from(deployments).all().map(({ release, status }) => [release, status])).toEqual([[1, "failed"], [2, "succeeded"]]);
  });

  test("the same push resent by GitHub is not built twice", async () => {
    const secret = await secretOf();
    const first = pushPayload();
    const second = pushPayload(undefined, undefined, "b".repeat(40));
    await push("hooks.example.com", "/hooks/github", first, sign(secret, first));
    await push("hooks.example.com", "/hooks/github", second, sign(secret, second));
    expect(await (await push("hooks.example.com", "/hooks/github", second, sign(secret, second))).json())
      .toEqual({ deployed: [], queued: [], skipped: [{ vhost: await vid("web.example.com"), reason: "That commit is already queued" }] });
  });

  test("also accepts the GitHub form format", async () => {
    const body = `payload=${encodeURIComponent(pushPayload())}`;
    const response = await push("hooks.example.com", "/hooks/github", body, sign(await secretOf(), body), "push", "application/x-www-form-urlencoded");
    expect(await response.json()).toMatchObject({ deployed: [await vid("web.example.com")] });
  });

  test("another branch, a ping or a deleted branch do not deploy", async () => {
    const secret = await secretOf();
    const other = pushPayload("refs/heads/dev");
    expect(await (await push("hooks.example.com", "/hooks/github", other, sign(secret, other))).json()).toEqual({ deployed: [], queued: [], skipped: [] });
    const ping = JSON.stringify({ zen: "x", repository: { html_url: "https://github.com/acme/front" } });
    const pong = await push("hooks.example.com", "/hooks/github", ping, sign(secret, ping), "ping");
    expect(pong.status).toBe(200);
    expect(await pong.json()).toEqual({ ok: true, apps: [await vid("web.example.com")] });
    const deleted = JSON.stringify({ ref: "refs/heads/main", deleted: true, repository: { html_url: "https://github.com/acme/front" } });
    expect((await push("hooks.example.com", "/hooks/github", deleted, sign(secret, deleted))).status).toBe(202);
    expect(calls.some(({ op }) => op === "app.build")).toBe(false);
  });

  test("without a valid signature it answers the same whether or not the repository exists, and does not deploy", async () => {
    const body = pushPayload();
    const wrong = await push("hooks.example.com", "/hooks/github", body, sign("other-secret", body));
    const unknown = pushPayload("refs/heads/main", "https://github.com/nobody/nothing");
    const missing = await push("hooks.example.com", "/hooks/github", unknown, sign(await secretOf(), unknown));
    expect([wrong.status, missing.status]).toEqual([401, 401]);
    expect(await wrong.json()).toEqual(await missing.json());
    expect(calls).toEqual([]);
  });

  test("with the webhook disabled, the previous secret no longer works", async () => {
    const secret = await secretOf();
    await post(`/vhosts/${await vid("web.example.com")}/webhook`, { enabled: false });
    expect((await vhostOf("acme", "web.example.com")).app!.webhook).toEqual({ secret: null, urls: ["https://hooks.example.com/hooks/github"] });
    const body = pushPayload();
    expect((await push("hooks.example.com", "/hooks/github", body, sign(secret, body))).status).toBe(401);
  });

  test("another host, or the account path on the global domain, do not exist", async () => {
    const body = pushPayload();
    const signature = sign(await secretOf(), body);
    expect((await push("other.example.com", "/hooks/github", body, signature)).status).toBe(404);
    expect((await push("hooks.example.com", "/_eaglepanel/github", body, signature)).status).toBe(404);
  });

  test("the domain of an environment cannot be used", async () => {
    expect((await post("/settings/server", { hooksDomain: "web.example.com" })).status).toBe(409);
  });

  test("a domain without a certificate works: with Flexible SSL, Cloudflare connects over HTTP", async () => {
    expect((await runJob("/settings/server", { hooksDomain: "hooks.sincertificado.com" })).status).toBe("succeeded");
    const sync = calls.filter(({ op }) => op === "ols.sync").at(-1)?.params as { hooks: { fqdn: string; certZone: string | null } };
    expect(sync.hooks).toEqual({ fqdn: "hooks.sincertificado.com", certZone: null });
  });
});

describe("account domain", () => {
  test("the account chooses one of its environments with a certificate, and its URL shows up in the app", async () => {
    expect((await post("/accounts/acme/hook-vhost", { vhost: await vid("example.com") })).status).toBe(202);
    for (let attempt = 0; attempt < 400 && db.select().from(accounts).all().find((row) => row.username === "acme")?.hookVhost !== await vid("example.com"); attempt += 1) await Bun.sleep(5);
    await Bun.sleep(20);
    expect(conf("example.com")).toContain("context /_eaglepanel/github {");
    expect(conf("web.example.com")).not.toContain("eaglepanel-api");
    expect((await vhostOf("acme", "web.example.com")).app!.webhook.urls).toEqual(["https://example.com/_eaglepanel/github"]);
    expect((await post("/accounts/acme/hook-vhost", { vhost: await vid("otra.com") })).status).toBe(400);
  });

  test("an environment without a certificate works: with Flexible SSL, Cloudflare connects over HTTP", async () => {
    db.delete(certificates).where(eq(certificates.zone, "example.com")).run();
    expect((await runJob("/accounts/acme/hook-vhost", { vhost: await vid("example.com") })).status).toBe("succeeded");
    expect(conf("example.com")).toContain("context /_eaglepanel/github {");
    // Without a certificate, there is neither an HTTPS redirect nor an SSL block: Cloudflare calls over HTTP and must get through.
    expect(conf("example.com")).not.toContain("vhssl");
    expect(conf("example.com")).not.toContain("RewriteCond %{HTTPS} !on");
  });

  test("deploys only apps of that account", async () => {
    db.update(accounts).set({ hookVhost: await vid("example.com") }).where(eq(accounts.username, "acme")).run();
    db.update(accounts).set({ hookVhost: await vid("otra.com") }).where(eq(accounts.username, "otra")).run();
    const body = pushPayload();
    const signature = sign(await secretOf(), body);
    expect(await (await push("example.com", "/_eaglepanel/github", body, signature)).json()).toMatchObject({ deployed: [await vid("web.example.com")] });
    expect((await push("otra.com", "/_eaglepanel/github", body, signature)).status).toBe(401);
  });

  test("a suspended account receives no webhooks", async () => {
    db.update(accounts).set({ hookVhost: await vid("example.com"), suspended: true }).where(eq(accounts.username, "acme")).run();
    const body = pushPayload();
    expect((await push("example.com", "/_eaglepanel/github", body, sign(await secretOf(), body))).status).toBe(404);
  });

  test("deleting the chosen environment clears the webhook domain", async () => {
    db.update(accounts).set({ hookVhost: await vid("web.example.com") }).where(eq(accounts.username, "acme")).run();
    expect((await runJob(`/vhosts/${await vid("web.example.com")}/delete`)).status).toBe("succeeded");
    expect(db.select().from(accounts).all().find((row) => row.username === "acme")?.hookVhost).toBeNull();
  });
});
