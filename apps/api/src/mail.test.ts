import { DEFAULT_LIMITS, type AccountDto, type AgentOpName, type JobDto, type MailDomainDto, type ServerMailDto } from "@eaglepanel/shared";
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
import { auditLog, jobSteps } from "./db/schema";
import { JobRunner } from "./jobs";
import { checkRecord, expectedRecords, joinTxtChunks, type DnsLookup } from "./mail-dns";
import { createSiteAccount } from "./test-support";

const PASSWORD = "test-password-value";
const passwordHash = await hashPassword(PASSWORD);
const SERVER_IP = "203.0.113.10";

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
let failOn: AgentOpName | null;
let mailInstalled: boolean;
let mailHostname: string;
let serverIp6: string | null;
let dns: { ptr: Record<string, string[]>; a: Record<string, string[]>; aaaa: Record<string, string[]>; mx: Record<string, { exchange: string; priority: number }[]>; txt: Record<string, string[]> };

const lookup: DnsLookup = {
  ptr: async (ip) => dns.ptr[ip] ?? [],
  a: async (name) => dns.a[name] ?? [],
  aaaa: async (name) => dns.aaaa[name] ?? [],
  mx: async (name) => dns.mx[name] ?? [],
  txt: async (name) => dns.txt[name] ?? [],
};

const agent: AgentClient = {
  call: (async (op: AgentOpName, params: unknown) => {
    calls.push({ op, params });
    if (op === "php.versions") return { versions: ["85"] };
    if (op === "system.publicIp") return { ip: SERVER_IP, ip6: serverIp6 };
    if (op === "mail.status") return { installed: mailInstalled, running: mailInstalled, hostname: mailInstalled ? mailHostname : null };
    if (failOn === op) {
      failOn = null;
      throw new Error(`simulated failure in ${op}`);
    }
    // The sandbox agent has its own name: here the server name is the one mail.status gives.
    if (op === "mail.server.cert.issue") return { hostname: mailHostname, notAfter: Date.now() + 90 * 24 * 3600 * 1000, renewed: true };
    const response = await dispatch({ op, params }, host);
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  }) as AgentClient["call"],
};

function post(path: string, body: unknown = {}) {
  return app.request(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eaglepanel": "1", cookie },
    body: JSON.stringify(body),
  });
}

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

const MAIL = "/accounts/acme/domains/example.com/mail";
const mail = async (zone = "example.com", username = "acme") =>
  (await (await app.request(`/api/accounts/${username}/domains/${zone}/mail`, { headers: { cookie } })).json()) as MailDomainDto;
const callsTo = (op: AgentOpName) => calls.filter((entry) => entry.op === op).map((entry) => entry.params);

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "eaglepanel-mail-"));
  roots.push(root);
  host = new SandboxHost(root);
  calls = [];
  failOn = null;
  mailInstalled = true;
  mailHostname = "mail.server.test";
  serverIp6 = null;
  dns = { ptr: {}, a: {}, aaaa: {}, mx: {}, txt: {} };
  db = openDb(":memory:");
  setAdminCredentials(db, "admin", passwordHash);
  jobs = new JobRunner(db);
  app = createApp({ db, agent, jobs, dnsLookup: lookup });
  await host.writeFileAtomic(HTTPD_CONFIG, "serverName test\n");
  const login = await post("/auth/login", { username: "admin", password: PASSWORD });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect((await createSiteAccount(runJob, { username: "acme", domain: "example.com", limits: DEFAULT_LIMITS })).status).toBe("succeeded");
  calls = [];
});

describe("enabling mail", () => {
  test("a domain without mail says so and lists nothing", async () => {
    const dto = await mail();
    expect(dto.enabled).toBe(false);
    expect(dto.available).toBe(true);
    expect(dto.records).toEqual([]);
  });

  test("creates the domain on the server and shows the DNS records to add", async () => {
    expect((await runJob(`${MAIL}/enable`)).status).toBe("succeeded");
    expect(callsTo("mail.domain.set")).toEqual([{ domain: "example.com", catchAll: null }]);
    const dto = await mail();
    expect(dto.enabled).toBe(true);
    expect(dto.mailHost).toBe("mail.example.com");
    const byType = dto.records.map(({ type, name, value }) => `${type} ${name} ${value}`);
    expect(byType).toContain(`A mail.example.com ${SERVER_IP}`);
    expect(byType).toContain("MX example.com mail.example.com");
    expect(byType).toContain("TXT example.com v=spf1 mx -all");
    expect(byType).toContain("TXT v1-ed25519-sandbox._domainkey.example.com v=DKIM1; k=ed25519; h=sha256; p=c2FuZGJveA==");
    expect(byType).toContain("TXT _dmarc.example.com v=DMARC1; p=none");
    expect(dto.records.every(({ state }) => state === "missing")).toBe(true);
    expect(dto.records.find(({ type }) => type === "A")?.dnsOnly).toBe(true);
  });

  test("refuses without mail installed, twice, or with a reserved subdomain in use", async () => {
    mailInstalled = false;
    expect((await post(`${MAIL}/enable`)).status).toBe(409);
    mailInstalled = true;
    expect((await runJob("/accounts/acme/hostnames", { fqdn: "webmail.example.com" })).status).toBe("succeeded");
    const blocked = await post(`${MAIL}/enable`);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toContain("webmail.example.com");
    expect((await runJob("/hostnames/webmail.example.com/delete")).status).toBe("succeeded");
    expect((await runJob(`${MAIL}/enable`)).status).toBe("succeeded");
    expect((await post(`${MAIL}/enable`)).status).toBe(409);
  });

  test("once enabled, the mail subdomains cannot be added", async () => {
    expect((await runJob(`${MAIL}/enable`)).status).toBe("succeeded");
    const response = await post("/accounts/acme/hostnames", { fqdn: "mail.example.com" });
    expect(response.status).toBe(409);
    expect((await runJob("/accounts/acme/hostnames", { fqdn: "shop.example.com" })).status).toBe("succeeded");
  });

  test("does not operate on another account's domain", async () => {
    expect((await createSiteAccount(runJob, { username: "otra", domain: "otra.com", limits: DEFAULT_LIMITS })).status).toBe("succeeded");
    expect((await post("/accounts/acme/domains/otra.com/mail/enable")).status).toBe(404);
    expect((await app.request("/api/accounts/acme/domains/otra.com/mail", { headers: { cookie } })).status).toBe(404);
  });
});

describe("mailboxes and forwarders", () => {
  beforeEach(async () => {
    expect((await runJob(`${MAIL}/enable`)).status).toBe("succeeded");
    calls = [];
  });

  test("creating a mailbox returns its password once and does not store it", async () => {
    const job = await runJob(`${MAIL}/mailboxes`, { name: "info", quotaMb: 500 });
    expect(job.status).toBe("succeeded");
    expect(job.secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(callsTo("mail.mailbox.set")).toEqual([{ domain: "example.com", name: "info", password: job.secret, quotaMb: 500, aliases: [] }]);
    const dto = await mail();
    expect(dto.mailboxes.map(({ address, quotaMb }) => [address, quotaMb])).toEqual([["info@example.com", 500]]);
    expect(JSON.stringify([db.select().from(auditLog).all(), db.select().from(jobSteps).all(), dto])).not.toContain(job.secret!);
  });

  test("an address is used once: mailbox, alias or forwarder", async () => {
    expect((await runJob(`${MAIL}/mailboxes`, { name: "info" })).status).toBe("succeeded");
    expect((await runJob(`${MAIL}/mailboxes/info`, { quotaMb: 1024, aliases: ["ventas", "hola"] })).status).toBe("succeeded");
    expect((await post(`${MAIL}/mailboxes`, { name: "ventas" })).status).toBe(409);
    expect((await post(`${MAIL}/forwarders`, { name: "hola", recipients: ["x@gmail.com"] })).status).toBe(409);
    expect((await post(`${MAIL}/mailboxes`, { name: "Info" })).status).toBe(400);
    expect((await runJob(`${MAIL}/forwarders`, { name: "pagos", recipients: ["Someone@Gmail.com", "info@example.com"] })).status).toBe("succeeded");
    expect(callsTo("mail.forwarder.set").at(-1)).toEqual({ domain: "example.com", name: "pagos", recipients: ["someone@gmail.com", "info@example.com"] });
    expect((await post(`${MAIL}/mailboxes/info`, { quotaMb: 1024, aliases: ["pagos"] })).status).toBe(409);
    expect((await post(`${MAIL}/forwarders`, { name: "loop", recipients: ["loop@example.com"] })).status).toBe(400);
    const dto = await mail();
    expect(dto.mailboxes[0]?.aliases).toEqual(["ventas", "hola"]);
    expect(dto.forwarders.map(({ address }) => address)).toEqual(["pagos@example.com"]);
  });

  test("regenerating the password keeps quota and aliases; deleting reaches the server", async () => {
    expect((await runJob(`${MAIL}/mailboxes`, { name: "info", quotaMb: 300 })).status).toBe("succeeded");
    const job = await runJob(`${MAIL}/mailboxes/info/password`);
    expect(job.status).toBe("succeeded");
    expect(callsTo("mail.mailbox.set").at(-1)).toEqual({ domain: "example.com", name: "info", password: job.secret, quotaMb: 300, aliases: [] });
    expect((await runJob(`${MAIL}/mailboxes/info/delete`)).status).toBe("succeeded");
    expect(callsTo("mail.mailbox.remove")).toEqual([{ domain: "example.com", name: "info" }]);
    expect((await mail()).mailboxes).toEqual([]);
  });

  test("if the server fails, the mailbox is not registered", async () => {
    failOn = "mail.mailbox.set";
    expect((await runJob(`${MAIL}/mailboxes`, { name: "info" })).status).toBe("rolled_back");
    expect((await mail()).mailboxes).toEqual([]);
  });

  test("catch-all goes to the server and is shown", async () => {
    expect((await runJob(`${MAIL}/catch-all`, { address: "info@example.com" })).status).toBe("succeeded");
    expect((await mail()).catchAll).toBe("info@example.com");
    expect((await runJob(`${MAIL}/catch-all`, { address: null })).status).toBe("succeeded");
    expect(callsTo("mail.domain.set").at(-1)).toEqual({ domain: "example.com", catchAll: null });
  });

  test("disabling mail, deleting the domain or the account deletes it from the server", async () => {
    expect((await runJob(`${MAIL}/mailboxes`, { name: "info" })).status).toBe("succeeded");
    expect((await runJob(`${MAIL}/disable`)).status).toBe("succeeded");
    expect(callsTo("mail.domain.remove")).toEqual([{ domain: "example.com" }]);
    expect((await mail()).enabled).toBe(false);

    expect((await runJob(`${MAIL}/enable`)).status).toBe("succeeded");
    expect((await runJob("/accounts/acme/delete", { confirm: "acme" })).status).toBe("succeeded");
    expect(callsTo("mail.domain.remove")).toEqual([{ domain: "example.com" }, { domain: "example.com" }]);
  });

  test("an account deletion with a second domain removes the mail of each one", async () => {
    await runJob("/accounts/acme/limits", { ...DEFAULT_LIMITS, domains: 2 });
    expect((await runJob("/accounts/acme/domains", { domain: "segundo.com" })).status).toBe("succeeded");
    expect((await runJob("/accounts/acme/domains/segundo.com/mail/enable")).status).toBe("succeeded");
    expect((await runJob("/accounts/acme/domains/segundo.com/delete")).status).toBe("succeeded");
    expect(callsTo("mail.domain.remove")).toEqual([{ domain: "segundo.com" }]);
    const account = (await (await app.request("/api/accounts/acme", { headers: { cookie } })).json()) as AccountDto;
    expect(account.domains.map(({ fqdn }) => fqdn)).toEqual(["example.com"]);
  });
});

describe("DNS check", () => {
  const records = expectedRecords("example.com", SERVER_IP, [{ selector: "s1", algorithm: "rsa", publicKey: "AAAB" }]);
  const find = (type: string, name: string) => records.find((record) => record.type === type && record.name === name)!;

  test("a long TXT that the resolver hands over in 255-byte pieces is one record again", () => {
    const first = `v=DKIM1; k=rsa; p=${"A".repeat(237)}`;
    expect(first.length).toBe(255);
    expect(joinTxtChunks([first, "QAB", "v=spf1 mx -all"])).toEqual([`${first}QAB`, "v=spf1 mx -all"]);
    expect(joinTxtChunks(["v=DMARC1; p=none", "v=spf1 mx -all"])).toEqual(["v=DMARC1; p=none", "v=spf1 mx -all"]);
  });

  test("each record is ok, missing or different", async () => {
    dns = {
      ptr: {},
      aaaa: {},
      a: { "mail.example.com": [SERVER_IP] },
      mx: { "example.com": [{ exchange: "mail.example.com.", priority: 10 }] },
      txt: {
        "example.com": ["google-site-verification=x", "v=spf1 include:_spf.google.com ~all"],
        "s1._domainkey.example.com": ["v=DKIM1; k=rsa; p=AAAB"],
        "_dmarc.example.com": ["v=DMARC1; p=reject; rua=mailto:x@example.com"],
      },
    };
    expect((await checkRecord(find("A", "mail.example.com"), lookup)).state).toBe("ok");
    expect((await checkRecord(find("MX", "example.com"), lookup)).state).toBe("ok");
    const spf = await checkRecord(find("TXT", "example.com"), lookup);
    expect(spf.state).toBe("different");
    expect(spf.found).toEqual(["v=spf1 include:_spf.google.com ~all"]);
    expect((await checkRecord(find("TXT", "s1._domainkey.example.com"), lookup)).state).toBe("ok");
    expect((await checkRecord(find("TXT", "_dmarc.example.com"), lookup)).state).toBe("ok");
  });

  test("behind the Cloudflare proxy the mail name answers other addresses", async () => {
    dns.a["mail.example.com"] = ["104.21.0.1", "172.67.0.1"];
    expect((await checkRecord(find("A", "mail.example.com"), lookup)).state).toBe("different");
  });

  test("a lookup error is unknown, not missing", async () => {
    const failing: DnsLookup = { ...lookup, mx: async () => { throw new Error("timeout"); } };
    expect((await checkRecord(find("MX", "example.com"), failing)).state).toBe("unknown");
  });
});

describe("certificate of mail.<domain>", () => {
  const certPath = `${MAIL}/certificate`;

  test("enabling mail publishes mail.<domain> on port 80 for the validation; disabling removes it", async () => {
    expect((await runJob(`${MAIL}/enable`)).status).toBe("succeeded");
    // With the server name, which always gets its own.
    expect((callsTo("ols.sync").at(-1) as { acmeHosts: string[] }).acmeHosts).toEqual(["mail.example.com", "mail.server.test"]);
    expect((await runJob(`${MAIL}/disable`)).status).toBe("succeeded");
    expect((callsTo("ols.sync").at(-1) as { acmeHosts: string[] }).acmeHosts).toEqual(["mail.server.test"]);
  });

  test("waits while mail.<domain> does not point here, and refuses to ask for it by hand", async () => {
    await runJob(`${MAIL}/enable`);
    expect((await mail()).certificate.state).toBe("waiting");
    const response = await post(certPath);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("does not point to this server");
    expect(callsTo("mail.cert.issue")).toEqual([]);
  });

  test("once it points here, it is issued by itself on the next check", async () => {
    await runJob(`${MAIL}/enable`);
    dns.a["mail.example.com"] = [SERVER_IP];
    await app.request(`/api${MAIL}?refresh=1`, { headers: { cookie } });
    for (let attempt = 0; attempt < 100 && (await mail()).certificate.state !== "valid"; attempt += 1) await Bun.sleep(5);
    const { certificate } = await mail();
    expect(certificate.state).toBe("valid");
    expect(certificate.notAfter).toBeGreaterThan(Date.now());
    expect(callsTo("mail.cert.issue")).toEqual([{ domain: "example.com" }]);
  });

  test("a failure is shown, and asking again by hand retries", async () => {
    await runJob(`${MAIL}/enable`);
    dns.a["mail.example.com"] = [SERVER_IP];
    failOn = "mail.cert.issue";
    expect((await runJob(certPath)).status).not.toBe("succeeded");
    const failed = (await mail()).certificate;
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("simulated failure");
    // The automatic check does not retry right after a failure.
    await app.request(`/api${MAIL}?refresh=1`, { headers: { cookie } });
    await Bun.sleep(20);
    expect(callsTo("mail.cert.issue")).toHaveLength(1);
    expect((await runJob(certPath)).status).toBe("succeeded");
    expect((await mail()).certificate).toMatchObject({ state: "valid", error: null });
  });
});

describe("server without mail", () => {
  test("a domain says mail is not installed, and enabling it is refused", async () => {
    mailInstalled = false;
    expect((await mail()).available).toBe(false);
    const response = await post(`${MAIL}/enable`);
    expect(response.status).toBe(409);
    expect(callsTo("mail.domain.set")).toEqual([]);
  });

  test("Settings says so", async () => {
    mailInstalled = false;
    const dto = (await (await app.request("/api/settings/mail", { headers: { cookie } })).json()) as ServerMailDto;
    expect(dto).toMatchObject({ installed: false, running: false, hostname: null, records: [] });
  });
});

describe("server mail (Settings)", () => {
  const settingsMail = async (refresh = false) =>
    (await (await app.request(`/api/settings/mail${refresh ? "?refresh=1" : ""}`, { headers: { cookie } })).json()) as ServerMailDto;

  test("shows the server name, its records, its reverse DNS and whether port 25 goes out", async () => {
    const dto = await settingsMail();
    expect(dto).toMatchObject({ installed: true, running: true, hostname: "mail.server.test", named: true, ip: SERVER_IP, port25: "open" });
    expect(dto.records.map(({ type, name, value, state }) => `${type} ${name} ${value} ${state}`)).toEqual([
      `A mail.server.test ${SERVER_IP} missing`,
      "TXT mail.server.test v=spf1 a -all missing",
    ]);
    expect(dto.ptrs).toEqual([{ ip: SERVER_IP, state: "missing", found: [] }]);
    expect(dto.certificate.state).toBe("waiting");

    dns.a["mail.server.test"] = [SERVER_IP];
    dns.txt["mail.server.test"] = ["v=spf1 a -all"];
    dns.ptr[SERVER_IP] = ["mail.server.test."];
    const checked = await settingsMail(true);
    expect(checked.records.every(({ state }) => state === "ok")).toBe(true);
    expect(checked.ptrs).toEqual([{ ip: SERVER_IP, state: "ok", found: ["mail.server.test"] }]);
  });

  test("a reverse DNS of the provider is different", async () => {
    dns.ptr[SERVER_IP] = ["vps-1234.provider.net"];
    expect((await settingsMail(true)).ptrs).toEqual([{ ip: SERVER_IP, state: "different", found: ["vps-1234.provider.net"] }]);
  });

  test("with IPv6 it also asks for the AAAA and the reverse DNS of that address", async () => {
    serverIp6 = "2001:db8:1::f32d";
    dns.aaaa["mail.server.test"] = ["2001:0db8:0001:0000:0000:0000:0000:f32d"]; // written out in full: the same address
    dns.ptr["2001:db8:1::f32d"] = ["vps-1234.provider.net."];
    const dto = await settingsMail(true);
    expect(dto.ip6).toBe("2001:db8:1::f32d");
    expect(dto.records.map(({ type, state }) => `${type} ${state}`)).toEqual(["A missing", "AAAA ok", "TXT missing"]);
    expect(dto.ptrs.map(({ ip, state }) => `${ip} ${state}`)).toEqual([`${SERVER_IP} missing`, "2001:db8:1::f32d different"]);
  });

  test("an AAAA pointing elsewhere holds the certificate back: the validation would try it first", async () => {
    serverIp6 = "2001:db8:1::f32d";
    dns.a["mail.server.test"] = [SERVER_IP];
    dns.aaaa["mail.server.test"] = ["2001:db8:2::1"];
    expect((await post("/settings/mail/certificate")).status).toBe(409);
    dns.aaaa["mail.server.test"] = ["2001:db8:1::f32d"];
    expect((await runJob("/settings/mail/certificate")).status).toBe("succeeded");
  });

  test("its certificate is requested once the name points here", async () => {
    expect((await post("/settings/mail/certificate")).status).toBe(409);
    dns.a["mail.server.test"] = [SERVER_IP];
    expect((await runJob("/settings/mail/certificate")).status).toBe("succeeded");
    expect(callsTo("mail.server.cert.issue")).toEqual([{}]);
    const { certificate } = await settingsMail();
    expect(certificate.state).toBe("valid");
    // Renamed with the installer: that certificate was for the previous name.
    mailHostname = "mail.other.test";
    expect((await settingsMail()).certificate.state).toBe("waiting");
  });

  test("its name is always published on port 80 for the validation", async () => {
    await runJob(`${MAIL}/enable`);
    expect((callsTo("ols.sync").at(-1) as { acmeHosts: string[] }).acmeHosts).toContain("mail.server.test");
  });

  test("the name is changed from Settings; one used by an environment is refused", async () => {
    expect((await post("/settings/mail/hostname", { hostname: "vps1.localdomain" })).status).toBe(400);
    const response = await post("/settings/mail/hostname", { hostname: "example.com" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("used by an environment");
    expect((await runJob("/settings/mail/hostname", { hostname: "mail.glez.dev" })).status).toBe("succeeded");
    expect(callsTo("mail.server.hostname.set")).toEqual([{ hostname: "mail.glez.dev" }]);
  });

  test("a placeholder name says so and has no certificate to ask for", async () => {
    mailHostname = "vps1.invalid";
    const dto = await settingsMail();
    expect(dto).toMatchObject({ hostname: "vps1.invalid", named: false, records: [] });
    const response = await post("/settings/mail/certificate");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("--mail-hostname");
  });
});
