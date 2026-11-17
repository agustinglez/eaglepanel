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
import { openDb } from "./db";
import { JobRunner } from "./jobs";

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
  const db = openDb(":memory:");
  setAdminCredentials(db, "admin", passwordHash);
  jobs = new JobRunner(db);
  app = createApp({ db, agent, jobs });
  await host.writeFileAtomic(HTTPD_CONFIG, "serverName test\n\nlistener Default{\n  address 127.0.0.1:8088\n}\n");

  const login = await post("/auth/login", { username: "admin", password: PASSWORD }, "");
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

function post(path: string, body: unknown, withCookie = cookie) {
  return app.request(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eaglepanel": "1", cookie: withCookie },
    body: JSON.stringify(body),
  });
}

const get = (path: string) => app.request(`/api${path}`, { headers: { cookie } });
const httpd = () => host.readFile(HTTPD_CONFIG);
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
const NEW_ACCOUNT = { username: "acme", domain: "example.com", phpVersion: "85", limits: LIMITS };
const blog = (fqdn = "blog.example.com") => ({ fqdn, domain: "example.com", phpVersion: "85" });

describe("create account", () => {
  test("creates user, vhost and public listeners", async () => {
    const job = await runJob("/accounts", NEW_ACCOUNT);
    expect(job.status).toBe("succeeded");

    const created = await account("acme");
    expect(created.limits).toEqual(LIMITS);
    expect(created.domains).toEqual(["example.com"]);
    expect(created.vhosts).toEqual([{ fqdn: "example.com", domain: "example.com", isMain: true, type: "php", docRoot: "public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, logLevel: "ERROR", logDays: 30, certZone: null, app: null }]);

    expect(readFileSync(vhostFile("example.com"), "utf8")).toContain("/home/acme/public_html");
    const config = await httpd();
    expect(config).toContain("virtualhost example.com {");
    expect(config).toContain("*:80");
    expect(config).not.toContain("*:443");

    const log = readFileSync(join(root, "commands.log"), "utf8");
    expect(log).toContain('"useradd"');
    expect(log).toContain('"setquota"');
  });

  test.each([
    [{ ...NEW_ACCOUNT, username: "root" }],
    [{ ...NEW_ACCOUNT, username: "a;rm -rf /" }],
    [{ ...NEW_ACCOUNT, domain: "../../etc" }],
    [{ ...NEW_ACCOUNT, domain: "a.com\nvirtualhost x" }],
    [{ ...NEW_ACCOUNT, limits: { ...LIMITS, quotaMb: 1 } }],
    [{ ...NEW_ACCOUNT, limits: { ...LIMITS, domains: 0 } }],
    [{ ...NEW_ACCOUNT, phpVersion: "85; rm" }],
    [{ ...NEW_ACCOUNT, extra: true }],
  ])("rejects %j", async (body) => {
    expect((await post("/accounts", body)).status).toBe(400);
    expect(calls).not.toContain("account.create");
  });

  test("rejects a PHP version that is not installed", async () => {
    expect((await post("/accounts", { ...NEW_ACCOUNT, phpVersion: "83" })).status).toBe(400);
    expect(calls).not.toContain("account.create");
  });

  test("does not repeat username or domain", async () => {
    await runJob("/accounts", NEW_ACCOUNT);
    expect((await post("/accounts", { ...NEW_ACCOUNT, domain: "other.test" })).status).toBe(409);
    expect((await post("/accounts", { ...NEW_ACCOUNT, username: "bravo" })).status).toBe(409);
  });

  test.each([
    ["account.create" as const, 0],
    ["site.write" as const, 0],
    ["ols.sync" as const, 0],
  ])("if %s fails, everything is rolled back", async (op) => {
    failOn = { op };
    const job = await runJob("/accounts", NEW_ACCOUNT);

    expect(job.status).toBe("rolled_back");
    expect(job.error).toContain("simulated failure");
    expect((await get("/accounts/acme")).status).toBe(404);
    expect(calls).toContain("account.delete");
    expect(await httpd()).not.toContain("virtualhost example.com");
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
      body: JSON.stringify(NEW_ACCOUNT),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Symlinks");
    expect(calls).not.toContain("account.create");
  });
});

describe("environments", () => {
  beforeEach(async () => {
    await runJob("/accounts", NEW_ACCOUNT);
  });

  test("creates and deletes without touching the site files", async () => {
    expect((await runJob("/accounts/acme/vhosts", blog())).status).toBe("succeeded");
    expect((await account("acme")).vhosts.map(({ fqdn }) => fqdn)).toEqual(["example.com", "blog.example.com"]);
    expect(readFileSync(vhostFile("blog.example.com"), "utf8")).toContain("/home/acme/subdomains/blog.example.com/public_html");
    expect(await httpd()).toContain("map                     blog.example.com blog.example.com");

    expect((await runJob("/vhosts/blog.example.com/delete", {})).status).toBe("succeeded");
    expect((await account("acme")).vhosts).toHaveLength(1);
    expect(await httpd()).not.toContain("blog.example.com");
    expect(removedVhost("blog.example.com")).toBe(true);
    expect(readFileSync(join(root, "commands.log"), "utf8")).not.toContain('"rm","args":["-rf","--","/home/');
  });

  test.each(["blog.other.test", "example.com", "evilexample.com"])("rejects %s as a subdomain", async (fqdn) => {
    expect((await post("/accounts/acme/vhosts", blog(fqdn))).status).toBe(400);
  });

  test("the primary environment cannot be deleted", async () => {
    expect((await post("/vhosts/example.com/delete", {})).status).toBe(400);
  });

  test("if OLS fails, the environment is rolled back", async () => {
    failOn = { op: "ols.sync" };
    const job = await runJob("/accounts/acme/vhosts", blog());
    expect(job.status).toBe("rolled_back");
    expect((await account("acme")).vhosts).toHaveLength(1);
    expect(removedVhost("blog.example.com")).toBe(true);
  });
});

describe("environment and domain limits", () => {
  const withLimits = (limits: Partial<typeof LIMITS>) => runJob("/accounts", { ...NEW_ACCOUNT, limits: { ...LIMITS, ...limits } });

  test("the primary one does not count and the additional one does", async () => {
    await withLimits({ vhosts: 1 });
    expect((await runJob("/accounts/acme/vhosts", blog())).status).toBe("succeeded");
    const response = await post("/accounts/acme/vhosts", blog("other.example.com"));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("limit");
  });

  test("by default a second domain is not allowed", async () => {
    await runJob("/accounts", NEW_ACCOUNT);
    expect((await post("/accounts/acme/domains", { domain: "other.test", phpVersion: "85" })).status).toBe(409);
  });

  test("an additional domain has its primary environment in its own directory", async () => {
    await withLimits({ domains: 2 });
    expect((await runJob("/accounts/acme/domains", { domain: "other.test", phpVersion: "85" })).status).toBe("succeeded");

    const { domains, vhosts } = await account("acme");
    expect(domains).toEqual(["example.com", "other.test"]);
    expect(vhosts.find(({ fqdn }) => fqdn === "other.test")).toMatchObject({ isMain: true, docRoot: "subdomains/other.test/public_html" });
    expect(readFileSync(vhostFile("example.com"), "utf8")).toContain("/home/acme/public_html");
    expect(await httpd()).toContain("virtualhost other.test {");
  });

  test("if OLS fails, the domain and its primary environment are rolled back", async () => {
    await withLimits({ domains: 2 });
    failOn = { op: "ols.sync" };
    expect((await runJob("/accounts/acme/domains", { domain: "other.test", phpVersion: "85" })).status).toBe("rolled_back");
    const { domains, vhosts } = await account("acme");
    expect(domains).toEqual(["example.com"]);
    expect(vhosts).toHaveLength(1);
  });

  test("an environment cannot hang from a foreign domain", async () => {
    await runJob("/accounts", NEW_ACCOUNT);
    await runJob("/accounts", { ...NEW_ACCOUNT, username: "bravo", domain: "bravo.test" });
    expect((await post("/accounts/acme/vhosts", { fqdn: "x.bravo.test", domain: "bravo.test", phpVersion: "85" })).status).toBe(400);
  });

  test.each(["example.com", "blog.example.com", "com.example.com"])("another account cannot register %s", async (domain) => {
    await runJob("/accounts", NEW_ACCOUNT);
    expect((await post("/accounts", { ...NEW_ACCOUNT, username: "bravo", domain })).status).toBe(409);
  });

  test("another account cannot register the parent domain", async () => {
    await runJob("/accounts", { ...NEW_ACCOUNT, domain: "blog.example.com" });
    expect((await post("/accounts", { ...NEW_ACCOUNT, username: "bravo", domain: "example.com" })).status).toBe(409);
  });

  test("each domain has its own certificate", async () => {
    await withLimits({ domains: 2 });
    await runJob("/accounts/acme/domains", { domain: "other.test", phpVersion: "85" });
    const cert = { certPem: fixture("origin.crt"), keyPem: fixture("origin.key") };
    expect((await runJob("/accounts/acme/domains/example.com/certificate", cert)).status).toBe("succeeded");

    const { vhosts } = await account("acme");
    expect(vhosts.find(({ fqdn }) => fqdn === "example.com")?.certZone).toBe("example.com");
    expect(vhosts.find(({ fqdn }) => fqdn === "other.test")?.certZone).toBeNull();
    expect((await post("/accounts/acme/domains/ajeno.test/certificate", cert)).status).toBe(404);
  });
});

describe("certificados", () => {
  const cert = { certPem: fixture("origin.crt"), keyPem: fixture("origin.key") };

  beforeEach(async () => {
    await runJob("/accounts", NEW_ACCOUNT);
    await runJob("/accounts/acme/vhosts", blog());
    await runJob("/accounts/acme/vhosts", blog("a.blog.example.com"));
  });

  test("publishes on 443 only the covered domains", async () => {
    expect((await runJob("/accounts/acme/domains/example.com/certificate", cert)).status).toBe("succeeded");

    const { vhosts, certificates } = await account("acme");
    expect(certificates[0]?.names).toEqual(["example.com", "*.example.com"]);
    expect(vhosts.find(({ fqdn }) => fqdn === "blog.example.com")?.certZone).toBe("example.com");
    expect(vhosts.find(({ fqdn }) => fqdn === "a.blog.example.com")?.certZone).toBeNull();

    const config = (await httpd()) ?? "";
    const https = config.slice(config.indexOf("listener eaglepanel-https"));
    expect(https).toContain("map                     blog.example.com blog.example.com");
    expect(https).not.toContain("a.blog.example.com");
    expect(readFileSync(vhostFile("example.com"), "utf8")).toContain("vhssl");
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
    expect((await account("acme")).certificates).toEqual([]);
    expect(await httpd()).not.toContain("*:443");
  });

  test("if OLS fails to apply it, the sites go back to having no certificate", async () => {
    failOn = { op: "ols.sync" };
    const job = await runJob("/accounts/acme/domains/example.com/certificate", cert);
    expect(job.status).toBe("rolled_back");
    expect((await account("acme")).certificates).toEqual([]);
    expect(readFileSync(vhostFile("example.com"), "utf8")).not.toContain("vhssl");
  });
});

describe("change PHP and limits", () => {
  beforeEach(async () => {
    await runJob("/accounts", NEW_ACCOUNT);
  });

  test("changing PHP restarts OLS even if the global block does not change", async () => {
    calls = [];
    expect((await runJob("/vhosts/example.com/php", { phpVersion: "84" })).status).toBe("succeeded");
    expect(calls).toContain("site.write");
    expect(calls).toContain("ols.sync");
    expect((await account("acme")).vhosts[0]?.phpVersion).toBe("84");
  });

  test("choosing the version it already has does not restart OLS", async () => {
    calls = [];
    expect((await post("/vhosts/example.com/php", { phpVersion: "85" })).status).toBe(409);
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
    await runJob("/accounts/acme/vhosts", blog());
    expect((await post("/accounts/acme/limits", { ...LIMITS, vhosts: 0 })).status).toBe(409);
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
    await runJob("/accounts", NEW_ACCOUNT);
  });

  test("requires typing the name", async () => {
    expect((await post("/accounts/acme/delete", { confirm: "otra" })).status).toBe(400);
    expect(calls).not.toContain("account.delete");
    expect((await get("/accounts/acme")).status).toBe(200);
  });

  test("deletes the account and leaves OLS without public ports", async () => {
    expect((await runJob("/accounts/acme/delete", { confirm: "acme" })).status).toBe("succeeded");
    expect((await get("/accounts/acme")).status).toBe(404);
    expect(removedVhost("example.com")).toBe(true);
    const config = await httpd();
    expect(config).not.toContain("*:80");
    expect(config).toContain("listener Default{");
  });

  test("if it fails before deleting files, it restores the sites", async () => {
    failOn = { op: "account.delete" };
    const job = await runJob("/accounts/acme/delete", { confirm: "acme" });
    expect(job.status).toBe("rolled_back");
    expect((await account("acme")).vhosts).toHaveLength(1);
    expect(existsSync(vhostFile("example.com"))).toBe(true);
    expect(await httpd()).toContain("virtualhost example.com {");
  });

  test("hosting routes require a session", async () => {
    const response = await app.request("/api/accounts");
    expect(response.status).toBe(401);
  });
});
