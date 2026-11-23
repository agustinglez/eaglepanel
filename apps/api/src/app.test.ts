import type { JobDto } from "@eaglepanel/shared";
import { beforeEach, describe, expect, test } from "bun:test";
import { Secret, TOTP } from "otpauth";
import type { AgentClient } from "./agent-client";
import { createApp } from "./app";
import { hashPassword, setAdminCredentials } from "./auth";
import { openDb, type Db } from "./db";
import { sessions } from "./db/schema";
import { JobRunner } from "./jobs";

const PASSWORD = "test-password-value";
const passwordHash = await hashPassword(PASSWORD);

const agent: AgentClient = {
  call: (async () => ({
    hostname: "test",
    platform: "linux",
    release: "1",
    osName: "Ubuntu 24.04.1 LTS",
    uptimeSeconds: 1,
    loadAverage: [0, 0, 0],
    memory: { totalBytes: 1, freeBytes: 1 },
    sandbox: true,
  })) as AgentClient["call"],
};

let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(":memory:");
  setAdminCredentials(db, "admin", passwordHash);
  app = createApp({ db, agent, jobs: new JobRunner(db) });
});

function post(path: string, body: unknown, cookie?: string, csrf = true) {
  return app.request(`/api${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(csrf ? { "x-eaglepanel": "1" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function login(): Promise<string> {
  const response = await post("/auth/login", { username: "admin", password: PASSWORD });
  expect(response.status).toBe(200);
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

describe("panel upgrade", () => {
  test("not started without a newer version, and only by an administrator", async () => {
    expect((await post("/system/update/install", {})).status).toBe(401);
    const cookie = await login();
    // Tests check no update source.
    expect((await post("/system/update/install", {}, cookie)).status).toBe(400);
  });
});

describe("authentication", () => {
  test("routes require a session", async () => {
    for (const path of ["/auth/me", "/system/info", "/jobs", "/audit"]) {
      expect((await app.request(`/api${path}`)).status).toBe(401);
    }
  });

  test("a correct login returns a protected cookie", async () => {
    const response = await post("/auth/login", { username: "admin", password: PASSWORD });
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");

    const me = await app.request("/api/auth/me", { headers: { cookie: header.split(";")[0] ?? "" } });
    expect(await me.json()).toEqual({ username: "admin", totpEnabled: false });
  });

  test("the database stores the token hash, not the token", async () => {
    const cookie = await login();
    const token = cookie.split("=")[1];
    const rows = db.select().from(sessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(token);
  });

  test("wrong username or password give the same error", async () => {
    const wrongPassword = await post("/auth/login", { username: "admin", password: "x" });
    const wrongUser = await post("/auth/login", { username: "other", password: "x" });
    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await wrongUser.json());
  });

  test("locks after several failed attempts, even with the correct password", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post("/auth/login", { username: "admin", password: "x" });
    }
    const response = await post("/auth/login", { username: "admin", password: PASSWORD });
    expect(response.status).toBe(429);
  });

  describe("per-origin lock", () => {
    /** Like Bun.serve: the second argument of fetch is the server, which knows the connection IP. */
    const from = (address: string, headers: Record<string, string> = {}) => (password: string) =>
      app.request(
        "/api/auth/login",
        { method: "POST", headers: { "content-type": "application/json", "x-eaglepanel": "1", ...headers }, body: JSON.stringify({ username: "admin", password }) },
        { requestIP: () => ({ address, family: "IPv4", port: 50000 }) },
      );

    beforeEach(() => {
      app = createApp({ db, agent, jobs: new JobRunner(db), localAddresses: ["10.0.0.1"] });
    });

    test("someone failing does not lock out the admin signing in from another IP", async () => {
      const attacker = from("203.0.113.5");
      for (let attempt = 0; attempt < 5; attempt += 1) await attacker("x");
      expect((await attacker(PASSWORD)).status).toBe(429);
      expect((await from("198.51.100.7")(PASSWORD)).status).toBe(200);
    });

    test("behind cloudflared, the CF-Connecting-IP address counts", async () => {
      const attacker = from("10.0.0.1", { "cf-connecting-ip": "203.0.113.5" });
      for (let attempt = 0; attempt < 5; attempt += 1) await attacker("x");
      expect((await attacker(PASSWORD)).status).toBe(429);
      expect((await from("10.0.0.1", { "cf-connecting-ip": "198.51.100.7" })(PASSWORD)).status).toBe(200);
    });

    test("from outside, CF-Connecting-IP cannot be used to bypass the lock", async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) await from("203.0.113.5", { "cf-connecting-ip": `198.51.100.${attempt}` })("x");
      expect((await from("203.0.113.5", { "cf-connecting-ip": "198.51.100.99" })(PASSWORD)).status).toBe(429);
    });

    test("local traffic has a shared cap, even if it fakes a different IP on every attempt", async () => {
      for (let attempt = 0; attempt < 25; attempt += 1) await from("127.0.0.1", { "cf-connecting-ip": `198.51.100.${attempt}` })("x");
      expect((await from("10.0.0.1", { "cf-connecting-ip": "192.0.2.1" })(PASSWORD)).status).toBe(429);
      expect((await from("203.0.113.9")(PASSWORD)).status).toBe(200);
    });

    test("over HTTPS the cookie is Secure", async () => {
      const response = await app.request("https://10.0.0.1:8090/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-eaglepanel": "1" },
        body: JSON.stringify({ username: "admin", password: PASSWORD }),
      });
      expect(response.headers.get("set-cookie")).toContain("Secure");
    });
  });

  test("logout invalidates the session", async () => {
    const cookie = await login();
    expect((await post("/auth/logout", {}, cookie)).status).toBe(200);
    expect((await app.request("/api/auth/me", { headers: { cookie } })).status).toBe(401);
  });

  test("a POST without the anti-CSRF header is rejected", async () => {
    const cookie = await login();
    expect((await post("/auth/logout", {}, cookie, false)).status).toBe(403);
    expect((await app.request("/api/auth/me", { headers: { cookie } })).status).toBe(200);
  });

  test("resetting credentials from the CLI closes the sessions", async () => {
    const cookie = await login();
    setAdminCredentials(db, "admin", passwordHash);
    expect((await app.request("/api/auth/me", { headers: { cookie } })).status).toBe(401);
  });
});

describe("TOTP", () => {
  function codeFor(secret: string, timestamp = Date.now()) {
    return new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: "SHA1" }).generate({ timestamp });
  }

  async function enable(cookie: string): Promise<string> {
    const setup = await post("/auth/totp/setup", {}, cookie);
    const { secret } = (await setup.json()) as { secret: string };
    expect((await post("/auth/totp/confirm", { code: "000000" }, cookie)).status).toBe(codeFor(secret) === "000000" ? 200 : 400);
    expect((await post("/auth/totp/confirm", { code: codeFor(secret) }, cookie)).status).toBe(200);
    return secret;
  }

  test("once enabled, login requires a code", async () => {
    const secret = await enable(await login());

    const withoutCode = await post("/auth/login", { username: "admin", password: PASSWORD });
    expect(await withoutCode.json()).toEqual({ totpRequired: true });
    expect(withoutCode.headers.get("set-cookie")).toBeNull();

    // The current code was already consumed when enabling: the next period's code is used.
    const next = codeFor(secret, Date.now() + 30_000);
    const withCode = await post("/auth/login", { username: "admin", password: PASSWORD, totp: next });
    expect(withCode.status).toBe(200);
    expect(withCode.headers.get("set-cookie")).toContain("ep_session=");
  });

  test("does not accept the same code twice", async () => {
    const secret = await enable(await login());
    const next = codeFor(secret, Date.now() + 30_000);

    expect((await post("/auth/login", { username: "admin", password: PASSWORD, totp: next })).status).toBe(200);
    expect((await post("/auth/login", { username: "admin", password: PASSWORD, totp: next })).status).toBe(401);
  });

  test("a wrong password does not reveal that TOTP is enabled", async () => {
    await enable(await login());
    const response = await post("/auth/login", { username: "admin", password: "x" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Incorrect username or password" });
  });
});

describe("job progress", () => {
  test("the stream sends every change and closes when finished", async () => {
    const jobs = new JobRunner(db);
    const streamApp = createApp({ db, agent, jobs });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { id, done } = jobs.enqueue({
      type: "t",
      title: "Prueba",
      steps: [{ name: "paso", run: () => gate }],
    });

    const cookie = await login();
    const response = await streamApp.request(`/api/jobs/${id}/stream`, { headers: { cookie } });
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    release();
    await done;

    const statuses = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => (JSON.parse(line.slice(6)) as JobDto).status);
    expect(statuses.at(-1)).toBe("succeeded");
  });

  test("the stream requires a session and an existing job", async () => {
    expect((await app.request("/api/jobs/x/stream")).status).toBe(401);
    const response = await app.request("/api/jobs/x/stream", { headers: { cookie: await login() } });
    expect(response.status).toBe(404);
  });
});

describe("system and audit log", () => {
  test("returns the agent information", async () => {
    const response = await app.request("/api/system/info", { headers: { cookie: await login() } });
    expect(await response.json()).toMatchObject({ hostname: "test", sandbox: true });
  });

  test("the audit log stores events without the password", async () => {
    await post("/auth/login", { username: "admin", password: "wrong-password" });
    const response = await app.request("/api/audit", { headers: { cookie: await login() } });
    const text = await response.text();
    expect(text).toContain("login.failed");
    expect(text).toContain("login.ok");
    expect(text).not.toContain("wrong-password");
    expect(text).not.toContain(PASSWORD);
  });

  test("does not send HSTS: it would affect customer subdomains without a certificate", async () => {
    const response = await app.request("/api/auth/me");
    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

describe("WordPress", () => {
  test("the Wordfence key is saved without being shown, and can be removed", async () => {
    expect((await app.request("/api/wordpress")).status).toBe(401);
    const cookie = await login();
    const get = async () => (await app.request("/api/settings/wordpress", { headers: { cookie } })).json();
    expect(await get()).toEqual({ wordfenceConfigured: false });
    expect((await post("/settings/wordpress", { wordfenceKey: "short" }, cookie)).status).toBe(400);
    const key = "wf-test-key-0123456789abcdef";
    expect((await post("/settings/wordpress", { wordfenceKey: key }, cookie)).status).toBe(200);
    expect(await get()).toEqual({ wordfenceConfigured: true });
    const status = await (await app.request("/api/wordpress", { headers: { cookie } })).text();
    expect(status).not.toContain(key);
    expect(JSON.parse(status)).toMatchObject({ installs: [], vulnerabilities: { configured: true } });
    expect((await post("/settings/wordpress", { wordfenceKey: null }, cookie)).status).toBe(200);
    expect(await get()).toEqual({ wordfenceConfigured: false });
    const audit = await (await app.request("/api/audit", { headers: { cookie } })).text();
    expect(audit).toContain("wordfence.key_set");
    expect(audit).not.toContain(key);
  });
});
