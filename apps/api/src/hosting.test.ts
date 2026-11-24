import { DEFAULT_LIMITS, DEFAULT_PHP_OPTIONS, type AccountDto, type AgentOpName, type JobDto } from "@eaglepanel/shared";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../agent/src/dispatch";
import { SandboxHost } from "../../agent/src/host";
import { HTTPD_CONFIG } from "../../agent/src/ols";
import type { AgentClient } from "./agent-client";
import { createApp } from "./app";
import { hashPassword, setAdminCredentials } from "./auth";
import { openDb, type Db } from "./db";
import { JobRunner } from "./jobs";
import { createHostingRoutes } from "./hosting";
import { addEnvironment as addSiteEnvironment, createSiteAccount } from "./test-support";

const PASSWORD = "test-password-value";
const passwordHash = await hashPassword(PASSWORD);
const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "..", "agent", "src", "testdata", name), "utf8");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let root: string;
let host: SandboxHost;
let failOn: { op: AgentOpName; after?: number } | null;
let calls: AgentOpName[];
let app: ReturnType<typeof createApp>;
let jobs: JobRunner;
let cookie: string;
let db: Db;

// Real integration: the API talks to the agent handlers in sandbox mode, without going through the network.
const agent: AgentClient = {
  call: (async (op: AgentOpName, params: unknown) => {
    calls.push(op);
    if (op === "php.versions") return { versions: ["85", "84"] };
    if (failOn?.op === op) {
      if ((failOn.after ?? 0) <= 0) {
        failOn = null;
        throw new Error(`simulated failure in ${op}`);
      }
      failOn.after = (failOn.after ?? 0) - 1;
    }
    const response = await dispatch({ op, params }, host);
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  }) as AgentClient["call"],
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "eaglepanel-hosting-"));
  roots.push(root);
  host = new SandboxHost(root);
  failOn = null;
  calls = [];
  db = openDb(":memory:");
  setAdminCredentials(db, "admin", passwordHash);
  jobs = new JobRunner(db);
  app = createApp({ db, agent, jobs });
  await host.writeFileAtomic(HTTPD_CONFIG, "serverName test\n\nlistener Default{\n  address 127.0.0.1:8088\n}\n");

  const login = await post("/auth/login", { username: "admin", password: PASSWORD }, "");
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});


/** The API names an environment by its id: the one that answers for that hostname. */
async function vid(hostname: string): Promise<number> {
  const response = await app.request("/api/accounts", { headers: { cookie } });
  for (const item of (await response.json()) as AccountDto[]) {
    const found = item.vhosts.find((vhost) => vhost.hostname === hostname);
    if (found) return found.id;
  }
  throw new Error(`No environment answers for ${hostname}`);
}

function post(path: string, body: unknown, withCookie = cookie) {
  return app.request(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eaglepanel": "1", cookie: withCookie },
    body: JSON.stringify(body),
  });
}

const get = (path: string) => app.request(`/api${path}`, { headers: { cookie } });
/** httpd_config.conf with the panel files it includes, as OLS reads it. In sandbox mode `rm` does nothing: only what is included counts. */
async function httpd(): Promise<string> {
  const config = (await host.readFile(HTTPD_CONFIG)) ?? "";
  const included = await Promise.all([...config.matchAll(/^include\s+(\S+)\s*$/gm)].map(async (match) => {
    const file = (await host.readFile(match[1]!)) ?? "";
    const configFile = /^\s*configFile\s+(conf\/eaglepanel\/\S+)\s*$/m.exec(file)?.[1];
    return configFile ? `${file}\n${(await host.readFile(`/usr/local/lsws/${configFile}`)) ?? ""}` : file;
  }));
  return [config, ...included].join("\n");
}
const vhostFile = (fqdn: string) => host.resolvePath(`/usr/local/lsws/conf/vhosts/${fqdn}/vhost.conf`);
/** The sandbox records `rm` without running it: the command is checked, not the file. */
const removedVhost = (fqdn: string) =>
  readFileSync(join(root, "commands.log"), "utf8").includes(`"rm","args":["-rf","--","/usr/local/lsws/conf/vhosts/${fqdn}"]`);
const account = async (username: string) => (await (await get(`/accounts/${username}`)).json()) as AccountDto;

/** Starts an operation and waits for its job to finish. */
async function runJob(path: string, body: unknown): Promise<JobDto> {
  const response = await post(path, body);
  expect(response.status).toBe(202);
  const { jobId } = (await response.json()) as { jobId: string };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = jobs.get(jobId);
    if (job && job.status !== "pending" && job.status !== "running") return job;
    await Bun.sleep(5);
  }
  throw new Error("The job did not finish");
}

const LIMITS = { ...DEFAULT_LIMITS, quotaMb: 500 };
const NEW_ACCOUNT = { username: "acme", domain: "example.com", limits: LIMITS };
const createAccount = (body: typeof NEW_ACCOUNT = NEW_ACCOUNT) => createSiteAccount(runJob, body);
/** A subdomain and an environment for it, with the slug the test helper gives it (`blog.example.com` -> `blogexamplecom`). */
async function addEnvironment(fqdn = "blog.example.com", username = "acme") {
  return addSiteEnvironment(runJob, username, fqdn);
}
const vhostOf = async (hostname: string) => (await account("acme")).vhosts.find((vhost) => vhost.hostname === hostname);

describe("panel configuration after an upgrade", () => {
  test("rewrites every environment once, restarts PHP, and does not repeat it", async () => {
    await createAccount();
    await addEnvironment();
    calls = [];
    const hosting = createHostingRoutes({ db, agent, jobs });
    const id = hosting.applyServerConfig();
    expect(id).not.toBeNull();
    for (let attempt = 0; attempt < 400 && jobs.get(id!)?.status !== "succeeded"; attempt += 1) await Bun.sleep(5);
    expect(jobs.get(id!)?.status).toBe("succeeded");
    expect(calls.filter((op) => op === "site.write")).toHaveLength(2);
    expect(calls).toContain("ols.sync");
    expect(calls).toContain("php.restart");
    expect(readFileSync(host.resolvePath("/etc/eaglepanel/php-accounts/acme/90-account.ini"), "utf8")).toContain("open_basedir=/home/acme");
    expect(hosting.applyServerConfig()).toBeNull();
  });

  test("with no environments there is nothing to rewrite", () => {
    const hosting = createHostingRoutes({ db, agent, jobs });
    expect(hosting.applyServerConfig()).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("create account", () => {
  test("creates the user and the general FTP, without domains or environments", async () => {
    const job = await runJob("/accounts", { username: "acme", limits: LIMITS });
    expect(job.status).toBe("succeeded");

    const created = await account("acme");
    expect(created.limits).toEqual(LIMITS);
    expect(created.domains).toEqual([]);
    expect(created.vhosts).toEqual([]);
    expect(created.ftpPasswordChangedAt).not.toBeNull();
    expect(await httpd()).not.toContain("virtualhost");

    const log = readFileSync(join(root, "commands.log"), "utf8");
    expect(log).toContain('"useradd"');
    expect(log).toContain('"setquota"');
  });

  test("an environment has a name, a slug that names everything on disk, and one domain", async () => {
    await runJob("/accounts", { username: "acme", limits: LIMITS });
    expect((await runJob("/accounts/acme/domains", { domain: "example.com" })).status).toBe("succeeded");
    expect((await account("acme")).domains).toEqual([{ fqdn: "example.com", hostnames: [{ fqdn: "example.com", vhost: null }], certificate: null }]);
    expect(calls).not.toContain("ols.sync");

    // Without a slug, it comes from the name: letters and digits, no accents.
    expect((await runJob("/accounts/acme/vhosts", { name: "Admin CRM Ñandú", hostname: "example.com", phpVersion: "85" })).status).toBe("succeeded");
    const created = await account("acme");
    expect(created.vhosts).toEqual([{
      id: created.vhosts[0]!.id, slug: "admincrmnandu", name: "Admin CRM Ñandú", hostname: "example.com", domain: "example.com",
      type: "php", docRoot: "sites/admincrmnandu/public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, logLevel: "ERROR", logDays: 30,
      certZone: null, extras: [], app: null, ftp: { login: "admincrmnandu@acme", root: "sites/admincrmnandu", passwordChangedAt: null },
    }]);
    expect(created.domains[0]?.hostnames).toEqual([{ fqdn: "example.com", vhost: { id: created.vhosts[0]!.id, name: "Admin CRM Ñandú", slug: created.vhosts[0]!.slug, mode: "main" } }]);

    const vhostConf = readFileSync(vhostFile("admincrmnandu"), "utf8");
    expect(vhostConf).toContain("/home/acme/sites/admincrmnandu/public_html");
    expect(vhostConf).toContain("/home/acme/sites/admincrmnandu/logs/php_error.log");
    const config = await httpd();
    expect(config).toContain("virtualhost admincrmnandu {");
    expect(config).toContain("map                     admincrmnandu example.com");
    expect(config).toContain("*:80");
    expect(config).not.toContain("*:443");
  });

  test.each([
    [{ username: "root", limits: LIMITS }],
    [{ username: "a;rm -rf /", limits: LIMITS }],
    [{ username: "acme", limits: { ...LIMITS, quotaMb: 1 } }],
    [{ username: "acme", limits: LIMITS, domain: "example.com" }],
    [{ username: "acme", limits: LIMITS, extra: true }],
  ])("rejects %j", async (body) => {
    expect((await post("/accounts", body)).status).toBe(400);
    expect(calls).not.toContain("account.create");
  });

  test.each(["../../etc", "a.com\nvirtualhost x"])("rejects the domain %j", async (domain) => {
    await runJob("/accounts", { username: "acme", limits: LIMITS });
    expect((await post("/accounts/acme/domains", { domain })).status).toBe(400);
  });

  test("rejects a PHP version that is not installed", async () => {
    await runJob("/accounts", { username: "acme", limits: LIMITS });
    await runJob("/accounts/acme/domains", { domain: "example.com" });
    expect((await post("/accounts/acme/vhosts", { name: "Web", hostname: "example.com", phpVersion: "83" })).status).toBe(400);
    expect(calls).not.toContain("site.write");
  });

  test("does not repeat the username", async () => {
    await createAccount();
    expect((await post("/accounts", { username: "acme", limits: LIMITS })).status).toBe(409);
  });

  test("if creating the user fails, everything is rolled back", async () => {
    failOn = { op: "account.create" };
    const job = await runJob("/accounts", { username: "acme", limits: LIMITS });
    expect(job.status).toBe("rolled_back");
    expect(job.error).toContain("simulated failure");
    expect((await get("/accounts/acme")).status).toBe(404);
    expect(calls).toContain("account.delete");
  });

  test.each(["site.write" as const, "ols.sync" as const])("if %s fails, the environment is rolled back and its domain is free again", async (op) => {
    await runJob("/accounts", { username: "acme", limits: LIMITS });
    await runJob("/accounts/acme/domains", { domain: "example.com" });
    failOn = { op };
    const job = await runJob("/accounts/acme/vhosts", { name: "Web", hostname: "example.com", phpVersion: "85" });
    expect(job.status).toBe("rolled_back");
    const after = await account("acme");
    expect(after.vhosts).toEqual([]);
    expect(after.domains[0]?.hostnames).toEqual([{ fqdn: "example.com", vhost: null }]);
    expect(await httpd()).not.toContain("virtualhost web");
  });

  test("the new account is not created if the server does not pass the checks", async () => {
    const blocked: AgentClient = {
      call: (async (op: AgentOpName, params: unknown) => {
        if (op === "system.preflight") return { ok: false, checks: [{ name: "Symlinks", ok: false, detail: "" }] };
        return agent.call(op, params as never);
      }) as AgentClient["call"],
    };
    const db = openDb(":memory:");
    setAdminCredentials(db, "admin", passwordHash);
    const blockedApp = createApp({ db, agent: blocked, jobs: new JobRunner(db) });
    const login = await blockedApp.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-eaglepanel": "1" },
      body: JSON.stringify({ username: "admin", password: PASSWORD }),
    });
    const response = await blockedApp.request("/api/accounts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eaglepanel": "1",
        cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
      },
      body: JSON.stringify({ username: "acme", limits: LIMITS }),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Symlinks");
    expect(calls).not.toContain("account.create");
  });
});

describe("environments", () => {
  beforeEach(async () => {
    await createAccount();
  });

  test("creates and deletes without touching the site files, and frees its domain", async () => {
    expect((await addEnvironment()).status).toBe("succeeded");
    expect((await account("acme")).vhosts.map(({ hostname }) => hostname)).toEqual(["blog.example.com", "example.com"]);
    expect(readFileSync(vhostFile("blogexamplecom"), "utf8")).toContain("/home/acme/sites/blogexamplecom/public_html");
    expect(await httpd()).toContain("map                     blogexamplecom blog.example.com");

    expect((await runJob(`/vhosts/${await vid("blog.example.com")}/delete`, {})).status).toBe("succeeded");
    const after = await account("acme");
    expect(after.vhosts).toHaveLength(1);
    expect(after.domains[0]?.hostnames).toContainEqual({ fqdn: "blog.example.com", vhost: null });
    expect(await httpd()).not.toContain("blog.example.com");
    expect(removedVhost("blogexamplecom")).toBe(true);
    expect(readFileSync(join(root, "commands.log"), "utf8")).not.toContain('"rm","args":["-rf","--","/home/');
  });

  test("any environment can be deleted, including the one of the domain itself", async () => {
    expect((await runJob(`/vhosts/${await vid("example.com")}/delete`, {})).status).toBe("succeeded");
    expect((await account("acme")).vhosts).toEqual([]);
  });

  test("www is not registered apart: OLS answers for it together with the name without it", async () => {
    const response = await post("/accounts/acme/hostnames", { fqdn: "www.example.com" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("together with example.com");
    expect((await post("/accounts/acme/domains", { domain: "www.other.test" })).status).toBe(400);
  });

  test("its domain changes without recreating it: same slug, same directory", async () => {
    await withLimits({ domains: 2 });
    await runJob("/accounts/acme/domains", { domain: "other.test" });
    const id = await vid("example.com");
    expect((await runJob(`/vhosts/${id}/hostname`, { hostname: "other.test" })).status).toBe("succeeded");
    expect(await vhostOf("other.test")).toMatchObject({ id, slug: "examplecom", domain: "other.test", docRoot: "sites/examplecom/public_html" });
    expect(await httpd()).toContain("map                     examplecom other.test");
    expect((await account("acme")).domains.find(({ fqdn }) => fqdn === "example.com")?.hostnames).toEqual([{ fqdn: "example.com", vhost: null }]);
  });

  test("a domain of another environment, of another account or that does not exist is rejected", async () => {
    await addEnvironment();
    const id = await vid("example.com");
    expect((await post(`/vhosts/${id}/hostname`, { hostname: "blog.example.com" })).status).toBe(409);
    expect((await post(`/vhosts/${id}/hostname`, { hostname: "nope.example.com" })).status).toBe(400);
    await createSiteAccount(runJob, { username: "bravo", domain: "bravo.test", limits: LIMITS });
    expect((await post(`/vhosts/${id}/hostname`, { hostname: "bravo.test" })).status).toBe(400);
  });

  test("renaming only the name changes nothing on the server", async () => {
    const id = await vid("example.com");
    calls = [];
    expect((await runJob(`/vhosts/${id}/name`, { name: "Sitio principal", slug: "examplecom" })).status).toBe("succeeded");
    expect(await vhostOf("example.com")).toMatchObject({ name: "Sitio principal", slug: "examplecom" });
    expect(calls).toEqual([]);
  });

  test("a new slug moves its directory and FTP and follows the default directory", async () => {
    const id = await vid("example.com");
    await runJob(`/vhosts/${id}/ftp/password`, {});
    expect((await runJob(`/vhosts/${id}/name`, { name: "Tienda", slug: "tienda" })).status).toBe("succeeded");
    expect(await vhostOf("example.com")).toMatchObject({ id, name: "Tienda", slug: "tienda", docRoot: "sites/tienda/public_html", ftp: { login: "tienda@acme", root: "sites/tienda" } });
    expect(calls).toContain("site.rename");
    expect(await httpd()).toContain("virtualhost tienda {");
    expect(await httpd()).not.toContain("virtualhost examplecom");
    expect(readFileSync(vhostFile("tienda"), "utf8")).toContain("/home/acme/sites/tienda/public_html");
  });

  test("a slug in use on the server, reserved or invalid is rejected", async () => {
    await createSiteAccount(runJob, { username: "bravo", domain: "bravo.test", limits: LIMITS });
    const id = await vid("example.com");
    expect((await post(`/vhosts/${id}/name`, { name: "X", slug: "bravotest" })).status).toBe(409);
    for (const slug of ["example", "with-dash", "Mayus", ""]) expect((await post(`/vhosts/${id}/name`, { name: "X", slug })).status).toBe(400);
    await runJob("/accounts/acme/hostnames", { fqdn: "blog.example.com" });
    expect((await post("/accounts/acme/vhosts", { name: "Bravo", slug: "bravotest", hostname: "blog.example.com", phpVersion: "85" })).status).toBe(409);
    expect((await post("/accounts/acme/vhosts", { name: "!!!", hostname: "blog.example.com", phpVersion: "85" })).status).toBe(400);
  });

  test("if renaming fails, everything goes back to the previous slug", async () => {
    const id = await vid("example.com");
    failOn = { op: "ols.sync" };
    expect((await runJob(`/vhosts/${id}/name`, { name: "Tienda", slug: "tienda" })).status).toBe("rolled_back");
    expect(await vhostOf("example.com")).toMatchObject({ slug: "examplecom", name: "example.com", docRoot: "sites/examplecom/public_html" });
  });

  test("an assigned name cannot be deleted, a free one can", async () => {
    await addEnvironment();
    expect((await post("/hostnames/blog.example.com/delete", {})).status).toBe(409);
    expect((await post("/hostnames/example.com/delete", {})).status).toBe(400);
    await runJob("/accounts/acme/hostnames", { fqdn: "free.example.com" });
    expect((await runJob("/hostnames/free.example.com/delete", {})).status).toBe("succeeded");
  });

  test("each environment can have its own FTP access, removed with the environment", async () => {
    await addEnvironment();
    const created = await runJob(`/vhosts/${await vid("blog.example.com")}/ftp/password`, {});
    expect(created.status).toBe("succeeded");
    expect(calls).toContain("ftp.setSitePassword");
    const vhost = await vhostOf("blog.example.com");
    expect(vhost?.ftp).toMatchObject({ login: "blogexamplecom@acme", root: "sites/blogexamplecom" });
    expect(vhost?.ftp?.passwordChangedAt).not.toBeNull();

    expect((await runJob(`/vhosts/${await vid("blog.example.com")}/ftp/delete`, {})).status).toBe("succeeded");
    expect((await vhostOf("blog.example.com"))?.ftp?.passwordChangedAt).toBeNull();
    expect((await post(`/vhosts/${await vid("blog.example.com")}/ftp/delete`, {})).status).toBe(409);

    calls = [];
    await runJob(`/vhosts/${await vid("blog.example.com")}/delete`, {});
    expect(calls).toContain("ftp.removeSite");
  });

  test.each(["blog.other.test", "evilexample.com"])("rejects %s as a subdomain", async (fqdn) => {
    expect((await post("/accounts/acme/hostnames", { fqdn })).status).toBe(400);
  });

  test("a name that does not exist or is already used cannot get an environment", async () => {
    expect((await post("/accounts/acme/vhosts", { name: "Blog", hostname: "blog.example.com", phpVersion: "85" })).status).toBe(400);
    expect((await post("/accounts/acme/vhosts", { name: "Otra", hostname: "example.com", phpVersion: "85" })).status).toBe(409);
  });

  test("if OLS fails, the environment is rolled back", async () => {
    await runJob("/accounts/acme/hostnames", { fqdn: "blog.example.com" });
    failOn = { op: "ols.sync" };
    const job = await runJob("/accounts/acme/vhosts", { name: "Blog", hostname: "blog.example.com", phpVersion: "85" });
    expect(job.status).toBe("rolled_back");
    expect((await account("acme")).vhosts).toHaveLength(1);
    expect(removedVhost("blog")).toBe(true);
  });
});

const withLimits = (limits: Partial<typeof LIMITS>) => runJob("/accounts/acme/limits", { ...LIMITS, ...limits });

describe("domains and environment limits", () => {
  beforeEach(async () => {
    await createAccount();
  });

  test("every environment counts", async () => {
    await withLimits({ vhosts: 2 });
    expect((await addEnvironment()).status).toBe("succeeded");
    await runJob("/accounts/acme/hostnames", { fqdn: "other.example.com" });
    const response = await post("/accounts/acme/vhosts", { name: "Other", hostname: "other.example.com", phpVersion: "85" });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("limit");
  });

  test("by default a second domain is not allowed, but subdomains are", async () => {
    expect((await post("/accounts/acme/domains", { domain: "other.test" })).status).toBe(409);
    expect((await runJob("/accounts/acme/hostnames", { fqdn: "a.example.com" })).status).toBe("succeeded");
    expect((await runJob("/accounts/acme/hostnames", { fqdn: "b.example.com" })).status).toBe("succeeded");
  });

  test("a domain with environments cannot be deleted; without them it goes with its subdomains and certificate", async () => {
    await withLimits({ domains: 2 });
    expect((await post("/accounts/acme/domains/example.com/delete", {})).status).toBe(409);

    await runJob("/accounts/acme/domains", { domain: "other.test" });
    await runJob("/accounts/acme/hostnames", { fqdn: "shop.other.test" });
    expect((await runJob("/accounts/acme/domains/other.test/delete", {})).status).toBe("succeeded");
    const { domains } = await account("acme");
    expect(domains.map(({ fqdn }) => fqdn)).toEqual(["example.com"]);
    expect((await post("/accounts/acme/hostnames", { fqdn: "x.other.test" })).status).toBe(400);
  });

  test("an environment cannot use a name of another account", async () => {
    await createSiteAccount(runJob, { username: "bravo", domain: "bravo.test", limits: LIMITS });
    expect((await post("/accounts/acme/vhosts", { name: "Bravo", hostname: "bravo.test", phpVersion: "85" })).status).toBe(400);
    expect((await post("/accounts/acme/hostnames", { fqdn: "x.bravo.test" })).status).toBe(400);
  });

  test.each(["example.com", "blog.example.com", "com.example.com"])("another account cannot register %s", async (domain) => {
    await runJob("/accounts", { username: "bravo", limits: LIMITS });
    expect((await post("/accounts/bravo/domains", { domain })).status).toBe(409);
  });

  test("each domain has its own certificate", async () => {
    await withLimits({ domains: 2 });
    await runJob("/accounts/acme/domains", { domain: "other.test" });
    await runJob("/accounts/acme/vhosts", { name: "Other", hostname: "other.test", phpVersion: "85" });
    const cert = { certPem: fixture("origin.crt"), keyPem: fixture("origin.key") };
    expect((await runJob("/accounts/acme/domains/example.com/certificate", cert)).status).toBe("succeeded");

    expect((await vhostOf("example.com"))?.certZone).toBe("example.com");
    expect((await vhostOf("other.test"))?.certZone).toBeNull();
    expect((await post("/accounts/acme/domains/ajeno.test/certificate", cert)).status).toBe(404);
  });
});

describe("aliases and redirects", () => {
  const cert = { certPem: fixture("origin.crt"), keyPem: fixture("origin.key") };
  beforeEach(async () => {
    await createAccount();
  });
  const main = async () => (await vhostOf("example.com"))!;
  const addExtra = async (fqdn: string, mode: "alias" | "redirect") => runJob(`/vhosts/${(await main()).id}/extras`, { fqdn, mode });

  test("an alias of its domain is mapped to the same vhost and shown on the domain", async () => {
    await runJob("/accounts/acme/hostnames", { fqdn: "shop.example.com" });
    expect((await addExtra("shop.example.com", "alias")).status).toBe("succeeded");
    expect((await main()).extras).toEqual([{ fqdn: "shop.example.com", mode: "alias", secure: false }]);
    expect(await httpd()).toContain("map                     examplecom example.com, shop.example.com");
    const { hostnames } = (await account("acme")).domains[0]!;
    expect(hostnames.find(({ fqdn }) => fqdn === "shop.example.com")?.vhost).toMatchObject({ slug: "examplecom", mode: "alias" });
  });

  test("an alias has to be of its domain and covered by its certificate; a redirect can be from anywhere in the account", async () => {
    await withLimits({ domains: 2 });
    await runJob("/accounts/acme/domains", { domain: "other.test" });
    const vhost = await main();
    expect((await post(`/vhosts/${vhost.id}/extras`, { fqdn: "other.test", mode: "alias" })).status).toBe(400);

    await runJob("/accounts/acme/domains/example.com/certificate", cert);
    await runJob("/accounts/acme/hostnames", { fqdn: "a.b.example.com" });
    const deep = await post(`/vhosts/${vhost.id}/extras`, { fqdn: "a.b.example.com", mode: "alias" });
    expect(deep.status).toBe(400);
    expect(await deep.text()).toContain("does not cover");

    expect((await addExtra("other.test", "redirect")).status).toBe("succeeded");
    expect((await addExtra("a.b.example.com", "redirect")).status).toBe("succeeded");
    const config = await httpd();
    // One vhost per domain, to the environment over HTTPS because it has a certificate.
    expect(config).toContain("virtualhost redirect_other.test {");
    expect(config).toContain("virtualhost redirect_example.com {");
    expect(config).toContain("RewriteCond %{HTTP_HOST} ^other\\.test(:\\d+)?$ [NC]\nRewriteRule ^ https://example.com%{REQUEST_URI} [R=301,L]");
    expect(config).toContain("map                     redirect_other.test other.test");
    expect((await main()).extras).toEqual([
      { fqdn: "a.b.example.com", mode: "redirect", secure: false },
      { fqdn: "other.test", mode: "redirect", secure: false },
    ]);
  });

  test("a name in use cannot be taken by another environment nor deleted until it is removed", async () => {
    await runJob("/accounts/acme/hostnames", { fqdn: "shop.example.com" });
    await addExtra("shop.example.com", "redirect");
    expect((await post("/accounts/acme/vhosts", { name: "Shop", hostname: "shop.example.com", phpVersion: "85" })).status).toBe(409);
    expect((await post(`/vhosts/${(await main()).id}/extras`, { fqdn: "shop.example.com", mode: "alias" })).status).toBe(409);
    expect((await post("/hostnames/shop.example.com/delete", {})).status).toBe(409);

    expect((await runJob(`/vhosts/${(await main()).id}/extras/shop.example.com/delete`, {})).status).toBe("succeeded");
    expect((await main()).extras).toEqual([]);
    expect(await httpd()).not.toContain("shop.example.com");
    expect((await runJob("/hostnames/shop.example.com/delete", {})).status).toBe("succeeded");
  });

  test("a domain with names in use cannot be deleted", async () => {
    await withLimits({ domains: 2 });
    await runJob("/accounts/acme/domains", { domain: "other.test" });
    await addExtra("other.test", "redirect");
    const response = await post("/accounts/acme/domains/other.test/delete", {});
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("other.test");
  });

  test("deleting the environment frees its names", async () => {
    await runJob("/accounts/acme/hostnames", { fqdn: "shop.example.com" });
    await addExtra("shop.example.com", "redirect");
    expect((await runJob(`/vhosts/${(await main()).id}/delete`, {})).status).toBe("succeeded");
    const { hostnames } = (await account("acme")).domains[0]!;
    expect(hostnames.find(({ fqdn }) => fqdn === "shop.example.com")?.vhost).toBeNull();
    expect(await httpd()).not.toContain("redirect_");
  });

  test("the redirects of a suspended account answer 503", async () => {
    await runJob("/accounts/acme/hostnames", { fqdn: "shop.example.com" });
    await addExtra("shop.example.com", "redirect");
    expect((await runJob("/accounts/acme/suspend", { suspended: true })).status).toBe("succeeded");
    const config = await httpd();
    expect(config).toContain("RewriteRule ^ - [R=503,L]");
    expect(config).not.toContain("R=301");
  });
});

describe("certificados", () => {
  const cert = { certPem: fixture("origin.crt"), keyPem: fixture("origin.key") };

  beforeEach(async () => {
    await createAccount();
    await addEnvironment();
    await addEnvironment("a.blog.example.com");
  });

  test("publishes on 443 only the covered domains", async () => {
    expect((await runJob("/accounts/acme/domains/example.com/certificate", cert)).status).toBe("succeeded");

    const { vhosts, domains } = await account("acme");
    expect(domains[0]?.certificate?.names).toEqual(["example.com", "*.example.com"]);
    expect(vhosts.find(({ hostname }) => hostname === "blog.example.com")?.certZone).toBe("example.com");
    expect(vhosts.find(({ hostname }) => hostname === "a.blog.example.com")?.certZone).toBeNull();

    const config = (await httpd()) ?? "";
    const https = config.slice(config.indexOf("listener eaglepanel-https"));
    expect(https).toContain("map                     blogexamplecom blog.example.com");
    expect(https).not.toContain("a.blog.example.com");
    expect(readFileSync(vhostFile("examplecom"), "utf8")).toContain("vhssl");
  });

  test("the private key does not appear in responses, jobs or the log", async () => {
    const job = await runJob("/accounts/acme/domains/example.com/certificate", cert);
    const keyBody = cert.keyPem.split("\n")[1] ?? "";
    expect(keyBody.length).toBeGreaterThan(20);

    const everything = [
      JSON.stringify(job),
      await (await get("/accounts/acme")).text(),
      await (await get("/audit")).text(),
      readFileSync(join(root, "commands.log"), "utf8"),
    ].join("\n");
    expect(everything).not.toContain(keyBody);
  });

  test("an invalid certificate is reported and nothing changes", async () => {
    const job = await runJob("/accounts/acme/domains/example.com/certificate", { ...cert, keyPem: fixture("other.key") });
    expect(job.status).toBe("rolled_back");
    expect(job.error).toContain("does not match");
    expect((await account("acme")).domains[0]?.certificate).toBeNull();
    expect(await httpd()).not.toContain("*:443");
  });

  test("if OLS fails to apply it, the sites go back to having no certificate", async () => {
    failOn = { op: "ols.sync" };
    const job = await runJob("/accounts/acme/domains/example.com/certificate", cert);
    expect(job.status).toBe("rolled_back");
    expect((await account("acme")).domains[0]?.certificate).toBeNull();
    expect(readFileSync(vhostFile("examplecom"), "utf8")).not.toContain("vhssl");
  });
});

describe("change PHP and limits", () => {
  beforeEach(async () => {
    await createAccount();
  });

  test("changing PHP restarts OLS even if the global block does not change", async () => {
    calls = [];
    expect((await runJob(`/vhosts/${await vid("example.com")}/php`, { phpVersion: "84" })).status).toBe("succeeded");
    expect(calls).toContain("site.write");
    expect(calls).toContain("ols.sync");
    expect((await account("acme")).vhosts[0]?.phpVersion).toBe("84");
  });

  test("choosing the version it already has does not restart OLS", async () => {
    calls = [];
    expect((await post(`/vhosts/${await vid("example.com")}/php`, { phpVersion: "85" })).status).toBe(409);
    expect(calls).toEqual([]);
  });

  test("updates the limits", async () => {
    calls = [];
    expect((await runJob("/accounts/acme/limits", { ...LIMITS, quotaMb: 1000, vhosts: 3 })).status).toBe("succeeded");
    expect(calls).toContain("account.setQuota");
    expect((await account("acme")).limits).toEqual({ ...LIMITS, quotaMb: 1000, vhosts: 3 });
  });

  test("changing another limit does not touch the system quota", async () => {
    calls = [];
    expect((await runJob("/accounts/acme/limits", { ...LIMITS, databases: 2 })).status).toBe("succeeded");
    expect(calls).not.toContain("account.setQuota");
  });

  test("does not lower a limit below what the account already uses", async () => {
    await addEnvironment();
    expect((await post("/accounts/acme/limits", { ...LIMITS, vhosts: 1 })).status).toBe(409);
    expect((await account("acme")).limits).toEqual(LIMITS);
  });

  test("if the quota fails, it keeps the previous values", async () => {
    failOn = { op: "account.setQuota" };
    expect((await runJob("/accounts/acme/limits", { ...LIMITS, quotaMb: 1000, vhosts: 3 })).status).toBe("rolled_back");
    expect((await account("acme")).limits).toEqual(LIMITS);
  });
});

describe("delete account", () => {
  beforeEach(async () => {
    await createAccount();
  });

  test("requires typing the name", async () => {
    expect((await post("/accounts/acme/delete", { confirm: "otra" })).status).toBe(400);
    expect(calls).not.toContain("account.delete");
    expect((await get("/accounts/acme")).status).toBe(200);
  });

  test("deletes the account and leaves OLS with port 80 only for the server mail name", async () => {
    expect((await runJob("/accounts/acme/delete", { confirm: "acme" })).status).toBe("succeeded");
    expect((await get("/accounts/acme")).status).toBe(404);
    expect(removedVhost("examplecom")).toBe(true);
    const config = await httpd();
    expect(config).not.toContain("*:443");
    expect(config).not.toContain("examplecom");
    expect(config).toContain("map                     eaglepanel-acme mail.sandbox.test");
    expect(config).toContain("listener Default{");
  });

  test("if it fails before deleting files, it restores the sites", async () => {
    failOn = { op: "account.delete" };
    const job = await runJob("/accounts/acme/delete", { confirm: "acme" });
    expect(job.status).toBe("rolled_back");
    expect((await account("acme")).vhosts).toHaveLength(1);
    expect(existsSync(vhostFile("examplecom"))).toBe(true);
    expect(await httpd()).toContain("virtualhost examplecom {");
  });

  test("hosting routes require a session", async () => {
    const response = await app.request("/api/accounts");
    expect(response.status).toBe(401);
  });
});
