import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult, Host } from "./host";
import { createJmap, createMailHandlers, MAIL_ADMIN_FILE } from "./mail";
import { ACME_NFT_TABLE, LEGO_BIN, legoCertPath, legoError, legoKeyPath, renderAcmeRedirect } from "./mail-cert";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "testdata", name), "utf8");

class FakeHost implements Host {
  readonly sandbox = false;
  readonly files = new Map<string, string>([[MAIL_ADMIN_FILE, "admin:s3cret-value\n"]]);
  readonly commands: string[][] = [];
  /** What lego leaves: the certificate it "issues", or a failure. */
  lego: { cert: string; key: string } | { error: string } = { cert: fixture("origin.crt"), key: fixture("origin.key") };
  async run(command: string, args: string[]): Promise<CommandResult> {
    this.commands.push([command, ...args]);
    if (command === LEGO_BIN) {
      if ("error" in this.lego) return { code: 1, stdout: "", stderr: this.lego.error };
      const name = args[args.indexOf("--domains") + 1]!;
      this.files.set(legoCertPath(name), this.lego.cert);
      this.files.set(legoKeyPath(name), this.lego.key);
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  async writeFileAtomic(path: string, content: string) {
    this.files.set(path, content);
  }
  async readFile(path: string) {
    return this.files.get(path) ?? null;
  }
}

type Row = Record<string, unknown> & { id: string };

/**
 * The part of the Stalwart administration API the agent uses, measured against Stalwart 1.2: objects by id, filters on
 * name and domainId, and a domain that cannot be destroyed while something points to it.
 */
class FakeStalwart {
  readonly store: Record<string, Row[]> = { "x:Domain": [], "x:Account": [], "x:MailingList": [], "x:DkimSignature": [], "x:Certificate": [], "x:Action": [] };
  settings: Record<string, unknown> & { id: string } = { id: "singleton", defaultHostname: "mail.server.test", defaultDomainId: "srv", defaultCertificateId: null };
  readonly requests: unknown[] = [];
  private next = 1;
  auth: string | null = null;

  constructor() {
    this.store["x:Domain"]!.push({ id: "srv", name: "server.test" });
  }

  fetcher = async (_url: string, init: RequestInit): Promise<Response> => {
    this.auth = (init.headers as Record<string, string>).authorization ?? null;
    if (this.auth !== `Basic ${Buffer.from("admin:s3cret-value").toString("base64")}`) return new Response("", { status: 401 });
    const body = JSON.parse(String(init.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
    this.requests.push(body);
    return Response.json({ methodResponses: body.methodCalls.map(([name, args, id]) => [...this.method(name, args), id]) });
  };

  private method(name: string, args: Record<string, unknown>): [string, Record<string, unknown>] {
    const [object, verb] = name.split("/") as [string, string];
    if (object === "x:SystemSettings") {
      if (verb === "set") Object.assign(this.settings, ((args.update ?? {}) as Record<string, object>).singleton);
      return [name, verb === "set" ? {} : { list: [this.settings] }];
    }
    const rows = this.store[object]!;
    if (verb === "query") {
      const filter = (args.filter ?? {}) as Record<string, unknown>;
      if (object === "x:MailingList" && "domainId" in filter) return ["error", { type: "unsupportedFilter" }];
      return [name, { ids: rows.filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value)).map((row) => row.id) }];
    }
    if (verb === "get") return [name, { list: rows.filter((row) => (args.ids as string[]).includes(row.id)) }];
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
      if (value.name !== undefined && rows.some((row) => row.name === value.name && row.domainId === value.domainId)) {
        result.notCreated = { [key]: { type: "primaryKeyViolation", description: "already exists" } };
        continue;
      }
      const id = `id${this.next++}`;
      // Stalwart reads the names from the certificate. The fixture is a wildcard: here it stands for mail.<domain>.
      const pem = (value.certificate as { value?: string } | undefined)?.value;
      const names = pem
        ? Object.fromEntries((new X509Certificate(pem).subjectAltName ?? "").split(", ").map((entry) => [entry.replace(/^DNS:/, "").replace(/^\*\./, "mail."), true]))
        : undefined;
      rows.push({ ...value, ...(names ? { subjectAlternativeNames: names } : {}), id });
      result.created = { ...(result.created as object), [key]: { id } };
    }
    for (const [id, value] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
      Object.assign(rows.find((row) => row.id === id)!, value);
    }
    for (const id of (args.destroy ?? []) as string[]) {
      const linked = (object === "x:Domain" && (Object.values(this.store).flat().some((row) => row.domainId === id) || this.settings.defaultDomainId === id))
        || (object === "x:Certificate" && this.settings.defaultCertificateId === id);
      if (linked) {
        result.notDestroyed = { [id]: { type: "objectIsLinked" } };
        continue;
      }
      rows.splice(rows.findIndex((row) => row.id === id), 1);
    }
    return [name, result];
  }
}

function setup() {
  const stalwart = new FakeStalwart();
  const host = new FakeHost();
  const jmap = createJmap(host, stalwart.fetcher);
  return { stalwart, host, handlers: createMailHandlers(() => jmap) };
}

describe("mail handlers against Stalwart", () => {
  test("a domain is created once and updated after", async () => {
    const { stalwart, host, handlers } = setup();
    await handlers["mail.domain.set"]({ domain: "acme.com", catchAll: null }, host);
    await handlers["mail.domain.set"]({ domain: "acme.com", catchAll: "info@acme.com" }, host);
    const domains = stalwart.store["x:Domain"]!.filter((row) => row.name === "acme.com");
    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({ enable: true, catchAllAddress: "info@acme.com" });
  });

  test("a mailbox needs a password to be created; updating without one keeps it", async () => {
    const { stalwart, host, handlers } = setup();
    await handlers["mail.domain.set"]({ domain: "acme.com", catchAll: null }, host);
    await expect(handlers["mail.mailbox.set"]({ domain: "acme.com", name: "info", quotaMb: 100, aliases: [] }, host)).rejects.toThrow("a password is needed");
    await handlers["mail.mailbox.set"]({ domain: "acme.com", name: "info", password: "AbCdEfGhIjKlMnOp", quotaMb: 100, aliases: ["ventas"] }, host);
    const account = stalwart.store["x:Account"]![0]!;
    expect(account).toMatchObject({
      "@type": "User",
      name: "info",
      quotas: { maxDiskQuota: 100 * 1024 * 1024 },
      aliases: { "0": { name: "ventas", domainId: account.domainId } },
      credentials: { "0": { "@type": "Password", secret: "AbCdEfGhIjKlMnOp" } },
    });
    await handlers["mail.mailbox.set"]({ domain: "acme.com", name: "info", quotaMb: 200, aliases: [] }, host);
    expect(stalwart.store["x:Account"]).toHaveLength(1);
    expect(account.quotas).toEqual({ maxDiskQuota: 200 * 1024 * 1024 });
    expect((account.credentials as Record<string, { secret: string }>)["0"]!.secret).toBe("AbCdEfGhIjKlMnOp");
  });

  test("a mailbox of a domain without mail is an error", async () => {
    const { host, handlers } = setup();
    await expect(handlers["mail.mailbox.set"]({ domain: "nope.com", name: "info", password: "AbCdEfGhIjKlMnOp", quotaMb: 100, aliases: [] }, host)).rejects.toThrow("nope.com has no mail");
  });

  test("forwarders are lists with external recipients", async () => {
    const { stalwart, host, handlers } = setup();
    await handlers["mail.domain.set"]({ domain: "acme.com", catchAll: null }, host);
    await handlers["mail.forwarder.set"]({ domain: "acme.com", name: "pagos", recipients: ["a@gmail.com", "b@acme.com"] }, host);
    await handlers["mail.forwarder.set"]({ domain: "acme.com", name: "pagos", recipients: ["c@gmail.com"] }, host);
    expect(stalwart.store["x:MailingList"]).toHaveLength(1);
    expect(stalwart.store["x:MailingList"]![0]!.recipients).toEqual({ "c@gmail.com": true });
    await handlers["mail.forwarder.remove"]({ domain: "acme.com", name: "pagos" }, host);
    expect(stalwart.store["x:MailingList"]).toHaveLength(0);
  });

  test("removing a domain deletes what points to it first, and keeps the server default domain", async () => {
    const { stalwart, host, handlers } = setup();
    await handlers["mail.domain.set"]({ domain: "acme.com", catchAll: null }, host);
    const id = stalwart.store["x:Domain"]!.find((row) => row.name === "acme.com")!.id;
    await handlers["mail.mailbox.set"]({ domain: "acme.com", name: "info", password: "AbCdEfGhIjKlMnOp", quotaMb: 100, aliases: [] }, host);
    await handlers["mail.forwarder.set"]({ domain: "acme.com", name: "pagos", recipients: ["a@gmail.com"] }, host);
    stalwart.store["x:DkimSignature"]!.push({ id: "k1", domainId: id, "@type": "Dkim1RsaSha256", selector: "v1-rsa", publicKey: "AAA", stage: "active" });
    await handlers["mail.domain.remove"]({ domain: "acme.com" }, host);
    expect(stalwart.store["x:Domain"]!.map((row) => row.name)).toEqual(["server.test"]);
    expect(stalwart.store["x:Account"]).toHaveLength(0);
    expect(stalwart.store["x:MailingList"]).toHaveLength(0);
    expect(stalwart.store["x:DkimSignature"]).toHaveLength(0);

    await handlers["mail.domain.set"]({ domain: "server.test", catchAll: null }, host);
    await handlers["mail.domain.remove"]({ domain: "server.test" }, host);
    expect(stalwart.store["x:Domain"]!.map((row) => row.name)).toEqual(["server.test"]);
    // Removing what does not exist is not an error.
    await handlers["mail.domain.remove"]({ domain: "acme.com" }, host);
  });

  test("DKIM returns the active keys of the domain only", async () => {
    const { stalwart, host, handlers } = setup();
    await handlers["mail.domain.set"]({ domain: "acme.com", catchAll: null }, host);
    const id = stalwart.store["x:Domain"]!.find((row) => row.name === "acme.com")!.id;
    stalwart.store["x:DkimSignature"]!.push(
      { id: "k1", domainId: id, "@type": "Dkim1RsaSha256", selector: "v1-rsa-20261124", publicKey: "RSAKEY", stage: "active" },
      { id: "k2", domainId: id, "@type": "Dkim1Ed25519Sha256", selector: "v1-ed25519-20261124", publicKey: "EDKEY", stage: "active" },
      { id: "k3", domainId: id, "@type": "Dkim1RsaSha256", selector: "v1-rsa-20260801", publicKey: "OLD", stage: "retired" },
      { id: "k4", domainId: "srv", "@type": "Dkim1RsaSha256", selector: "v1-rsa-x", publicKey: "OTHER", stage: "active" },
    );
    expect((await handlers["mail.domain.dkim"]({ domain: "acme.com" }, host)).keys).toEqual([
      { selector: "v1-ed25519-20261124", algorithm: "ed25519", publicKey: "EDKEY" },
      { selector: "v1-rsa-20261124", algorithm: "rsa", publicKey: "RSAKEY" },
    ]);
  });

  test("status reads the hostname; wrong credentials or no server are reported", async () => {
    const { host, handlers } = setup();
    expect(await handlers["mail.status"]({}, host)).toEqual({ installed: true, running: true, hostname: "mail.server.test", webmail: false });

    const wrong = new FakeHost();
    wrong.files.set(MAIL_ADMIN_FILE, "admin:other");
    const jmap = createJmap(wrong, new FakeStalwart().fetcher);
    await expect(jmap.ids("x:Domain")).rejects.toThrow("rejected the panel credentials");

    const missing = new FakeHost();
    missing.files.clear();
    await expect(createJmap(missing, new FakeStalwart().fetcher).ids("x:Domain")).rejects.toThrow("Mail is not installed");

    const down = createJmap(new FakeHost(), async () => { throw new TypeError("connection refused"); });
    await expect(down.ids("x:Domain")).rejects.toThrow("The mail server is not answering");
  });

  test("a certificate is issued, installed and reloaded; the same one again changes nothing", async () => {
    const { stalwart, host, handlers } = setup();
    await handlers["mail.domain.set"]({ domain: "example.com", catchAll: null }, host);
    const first = await handlers["mail.cert.issue"]({ domain: "example.com" }, host);
    expect(first.renewed).toBe(true);
    expect(first.notAfter).toBe(new Date(new X509Certificate(fixture("origin.crt")).validTo).getTime());
    const lego = host.commands.find(([command]) => command === LEGO_BIN)!;
    expect(lego).toContain("--http");
    expect(lego.slice(lego.indexOf("--domains"))).toEqual(["--domains", "mail.example.com"]);
    expect(stalwart.store["x:Certificate"]).toHaveLength(1);
    expect(stalwart.store["x:Action"]).toEqual([expect.objectContaining({ "@type": "ReloadTlsCertificates" })]);
    // Open firewall: nothing to open or close.
    expect(host.commands.some(([command]) => command === "nft" || command === "ufw")).toBe(false);

    const again = await handlers["mail.cert.issue"]({ domain: "example.com" }, host);
    expect(again.renewed).toBe(false);
    expect(stalwart.store["x:Action"]).toHaveLength(1);
  });

  test("a renewed certificate replaces the previous one, and only that one", async () => {
    const { stalwart, host, handlers } = setup();
    await handlers["mail.domain.set"]({ domain: "example.com", catchAll: null }, host);
    stalwart.store["x:Certificate"]!.push({ id: "old", certificate: { value: "OLD" }, subjectAlternativeNames: { "mail.example.com": true } });
    stalwart.store["x:Certificate"]!.push({ id: "other", certificate: { value: "X" }, subjectAlternativeNames: { "mail.other.com": true } });
    await handlers["mail.cert.issue"]({ domain: "example.com" }, host);
    const ids = stalwart.store["x:Certificate"]!.map((row) => row.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("other");
    expect(ids).not.toContain("old");
  });

  test("with the firewall limited to Cloudflare, port 80 is redirected only during the validation, even if it fails", async () => {
    const { host, handlers } = setup();
    host.files.set("/etc/eaglepanel/install.conf", "FIREWALL=open\nFIREWALL=cloudflare\n");
    host.files.set("/etc/eaglepanel/cloudflare-ips.txt", "173.245.48.0/20\n2400:cb00::/32\n");
    await handlers["mail.domain.set"]({ domain: "example.com", catchAll: null }, host);
    host.lego = { error: 'time=x level=ERROR msg="Could not obtain certificates" detail="Invalid response from http://mail.example.com/.well-known/acme-challenge/abc: 404"' };
    await expect(handlers["mail.cert.issue"]({ domain: "example.com" }, host)).rejects.toThrow("Invalid response from http://mail.example.com");
    const order = host.commands.map(([command, ...args]) => `${command} ${args.join(" ")}`);
    const timer = order.findIndex((line) => line.startsWith("systemd-run"));
    const redirect = order.findIndex((line) => line.startsWith("nft -f"));
    const lego = order.findIndex((line) => line.startsWith(LEGO_BIN));
    const closed = order.findLastIndex((line) => line === `nft delete table inet ${ACME_NFT_TABLE}`);
    expect(timer).toBeGreaterThanOrEqual(0);
    expect(timer).toBeLessThan(redirect);
    expect(redirect).toBeLessThan(lego);
    expect(closed).toBeGreaterThan(lego);
    expect(order.slice(lego)).toContain("ufw delete allow 8402/tcp");
  });

  test("the redirect leaves Cloudflare out, in IPv4 and IPv6", () => {
    const rules = renderAcmeRedirect(["173.245.48.0/20", "103.21.244.0/22", "2400:cb00::/32"]);
    expect(rules).toContain("elements = { 173.245.48.0/20, 103.21.244.0/22 }");
    expect(rules).toContain("elements = { 2400:cb00::/32 }");
    expect(rules).toContain("ip saddr != @cloudflare4 redirect to :8402");
    expect(rules).toContain("ip6 saddr != @cloudflare6 redirect to :8402");
  });

  test("lego errors keep what the person can act on", () => {
    expect(legoError('time=2026 level=ERROR msg="Could not obtain certificates" detail="acme: error: 403 :: urn:ietf:params:acme:error:unauthorized :: Invalid response"'))
      .toBe("acme: error: 403 :: urn:ietf:params:acme:error:unauthorized :: Invalid response");
    expect(legoError("\x1b[31msomething broke\x1b[0m")).toBe("something broke");
  });

  test("removing the domain removes its certificate too", async () => {
    const { stalwart, host, handlers } = setup();
    await handlers["mail.domain.set"]({ domain: "example.com", catchAll: null }, host);
    await handlers["mail.cert.issue"]({ domain: "example.com" }, host);
    await handlers["mail.domain.remove"]({ domain: "example.com" }, host);
    expect(stalwart.store["x:Certificate"]).toHaveLength(0);
    expect(host.commands.some(([command, ...args]) => command === "rm" && args.includes(legoCertPath("mail.example.com")))).toBe(true);
  });

  test("the server name gets its certificate, which becomes the default; renewing keeps it the default", async () => {
    const { stalwart, host, handlers } = setup();
    // The fixture stands for mail.<domain>: with the server name in that shape, the fake reads it as covering it.
    stalwart.settings.defaultHostname = "mail.example.com";
    const result = await handlers["mail.server.cert.issue"]({}, host);
    expect(result.hostname).toBe("mail.example.com");
    const first = stalwart.store["x:Certificate"]![0]!.id;
    expect(stalwart.settings.defaultCertificateId).toBe(first);

    // A new certificate from lego replaces it while it is the default (Stalwart refuses to destroy a linked one).
    host.lego = { cert: fixture("origin.crt").replace(/\n$/, "\n\n"), key: fixture("origin.key") };
    await handlers["mail.server.cert.issue"]({}, host);
    const second = stalwart.store["x:Certificate"]!.map((row) => row.id);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first);
    expect(stalwart.settings.defaultCertificateId).toBe(second[0]);
  });

  test("a domain whose mail name is the server name keeps that certificate, also when its mail is removed", async () => {
    const { stalwart, host, handlers } = setup();
    stalwart.settings.defaultHostname = "mail.example.com";
    await handlers["mail.server.cert.issue"]({}, host);
    await handlers["mail.domain.set"]({ domain: "example.com", catchAll: null }, host);
    host.lego = { cert: fixture("origin.crt").replace(/\n$/, "\n\n"), key: fixture("origin.key") };
    await handlers["mail.cert.issue"]({ domain: "example.com" }, host);
    const [only] = stalwart.store["x:Certificate"]!;
    expect(stalwart.settings.defaultCertificateId).toBe(only!.id);
    await handlers["mail.domain.remove"]({ domain: "example.com" }, host);
    expect(stalwart.store["x:Certificate"]!.map((row) => row.id)).toEqual([only!.id]);
  });

  test("the server name changes in Stalwart and in the installer settings, with its domain as the default", async () => {
    const { stalwart, host, handlers } = setup();
    host.files.set("/etc/eaglepanel/install.conf", "# Choices\nFIREWALL=cloudflare\nMAIL_HOSTNAME=vps1.invalid\nPANEL_PORT=8090\n");
    await handlers["mail.server.hostname.set"]({ hostname: "mail.glez.dev" }, host);
    const domain = stalwart.store["x:Domain"]!.find((row) => row.name === "glez.dev")!;
    expect(stalwart.settings).toMatchObject({ defaultHostname: "mail.glez.dev", defaultDomainId: domain.id });
    expect(stalwart.store["x:Action"]).toEqual([expect.objectContaining({ "@type": "ReloadSettings" })]);
    expect(host.files.get("/etc/eaglepanel/install.conf")).toBe("# Choices\nFIREWALL=cloudflare\nPANEL_PORT=8090\nMAIL_HOSTNAME=mail.glez.dev\n");
    // Again: the domain is reused.
    await handlers["mail.server.hostname.set"]({ hostname: "mx.glez.dev" }, host);
    expect(stalwart.store["x:Domain"]!.filter((row) => row.name === "glez.dev")).toHaveLength(1);
    expect(host.files.get("/etc/eaglepanel/install.conf")).toContain("MAIL_HOSTNAME=mx.glez.dev\n");
  });

  test("without a real server name there is no certificate to ask for", async () => {
    const { stalwart, host, handlers } = setup();
    stalwart.settings.defaultHostname = "vps1.invalid";
    await expect(handlers["mail.server.cert.issue"]({}, host)).rejects.toThrow("--mail-hostname");
    expect(host.commands.some(([command]) => command === LEGO_BIN)).toBe(false);
  });

  test("a rejected change fails with Stalwart's reason", async () => {
    const { stalwart, host } = setup();
    const jmap = createJmap(host, stalwart.fetcher);
    await jmap.set("x:Account", { create: { a: { name: "x", domainId: "srv" } } });
    await expect(jmap.set("x:Account", { create: { a: { name: "x", domainId: "srv" } } })).rejects.toThrow("already exists");
  });
});
