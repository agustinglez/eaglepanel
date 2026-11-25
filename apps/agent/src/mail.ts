import { MAIL_HTTP_PORT, mailHostOf, type AgentOpParams, type AgentOpResult, type DkimKey } from "@eaglepanel/shared";
import type { Host } from "./host";
import { connect } from "node:net";
import { forgetCertificate, INSTALL_CONF, obtainCertificate } from "./mail-cert";
import { backupPasswordHash, discardImport, importFromBackup, importFromImap, jmapSink, scanBackup, type MailboxSink } from "./mail-import";
import { ROUNDCUBE_CONFIG_DIR, ROUNDCUBE_DIR } from "./ols";

/** Mail servers of large providers, always up: if none answers on port 25, the provider blocks it. */
const PORT25_PROBES = ["gmail-smtp-in.l.google.com", "mx1.mail.icloud.com", "mx-aol.mail.gm0.yahoodns.net"];

/** A TCP connection that gets the server greeting (220) is enough: nothing is sent. */
function greets(hostname: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: 25 });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("data", (data) => done(data.toString().startsWith("220")));
    socket.once("error", () => done(false));
  });
}

export async function canReachPort25(probes = PORT25_PROBES): Promise<boolean> {
  for (const probe of probes) if (await greets(probe)) return true;
  return false;
}

/** `admin:<secret>`, written by the installer, root only. Stalwart reads the same pair as its recovery administrator. */
export const MAIL_ADMIN_FILE = "/etc/eaglepanel/mail-admin";
export const STALWART_BIN = "/usr/local/bin/stalwart";
const JMAP_URL = `http://127.0.0.1:${MAIL_HTTP_PORT}/jmap`;
const USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"];
const TIMEOUT_MS = 30_000;
const MB = 1024 * 1024;

type Args = Record<string, unknown>;
type MethodCall = [string, Args];
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

interface SetError {
  type?: string;
  description?: string;
}

interface SetResponse {
  created?: Record<string, { id: string }>;
  notCreated?: Record<string, SetError>;
  notUpdated?: Record<string, SetError>;
  notDestroyed?: Record<string, SetError>;
}

const setErrorText = (error: SetError | undefined) => error?.description ?? error?.type ?? "rejected";

/** The first object a `/set` could not create, update or destroy fails the whole operation. */
function checkSet(method: string, response: SetResponse): SetResponse {
  for (const key of ["notCreated", "notUpdated", "notDestroyed"] as const) {
    const failed = Object.values(response[key] ?? {})[0];
    if (failed) throw new Error(`Stalwart (${method}): ${setErrorText(failed)}`);
  }
  return response;
}

/** JMAP client for the Stalwart administration API. Every method response that is an error fails the request. */
export function createJmap(host: Host, fetcher: Fetcher = fetch) {
  let auth: string | null = null;

  async function authorization(): Promise<string> {
    if (auth) return auth;
    const pair = (await host.readFile(MAIL_ADMIN_FILE))?.trim();
    if (!pair || !pair.includes(":")) throw new Error("Mail is not installed on this server");
    auth = `Basic ${Buffer.from(pair).toString("base64")}`;
    return auth;
  }

  async function request(calls: MethodCall[]): Promise<Args[]> {
    let response: Response;
    try {
      response = await fetcher(JMAP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: await authorization() },
        body: JSON.stringify({ using: USING, methodCalls: calls.map(([name, args], index) => [name, args, `c${index}`]) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Mail is not installed on this server") throw error;
      throw new Error("The mail server is not answering");
    }
    if (response.status === 401) {
      auth = null;
      throw new Error("The mail server rejected the panel credentials");
    }
    if (!response.ok) throw new Error(`The mail server answered ${response.status}`);
    const body = (await response.json()) as { methodResponses?: [string, Args, string][] };
    const results = body.methodResponses ?? [];
    return calls.map(([name], index) => {
      const entry = results.find(([, , id]) => id === `c${index}`);
      if (!entry) throw new Error(`Stalwart did not answer ${name}`);
      const [kind, args] = entry;
      if (kind === "error") throw new Error(`Stalwart (${name}): ${String(args.description ?? args.type ?? "error")}`);
      return args;
    });
  }

  const one = async (name: string, args: Args) => (await request([[name, args]]))[0]!;
  const set = async (object: string, args: Args) => checkSet(`${object}/set`, (await one(`${object}/set`, args)) as SetResponse);
  const ids = async (object: string, filter?: Args) => ((await one(`${object}/query`, filter ? { filter } : {})).ids as string[] | undefined) ?? [];
  async function get<T>(object: string, idList: string[], properties: string[]): Promise<(T & { id: string })[]> {
    if (idList.length === 0) return [];
    return ((await one(`${object}/get`, { ids: idList, properties: [...properties, "id"] })).list as (T & { id: string })[] | undefined) ?? [];
  }

  return { request, set, ids, get };
}

export type Jmap = ReturnType<typeof createJmap>;

/** `sinkFor` writes into a mailbox (JMAP as that mailbox): replaceable in tests. */
export function createMailHandlers(jmapFor: (host: Host) => Jmap, sinkFor: (host: Host, address: string) => Promise<MailboxSink> = jmapSink) {
  async function domainId(jmap: Jmap, domain: string): Promise<string | null> {
    const found = await jmap.get<{ name: string }>("x:Domain", await jmap.ids("x:Domain", { name: domain }), ["name"]);
    return found.find((row) => row.name === domain)?.id ?? null;
  }

  async function requireDomain(jmap: Jmap, domain: string): Promise<string> {
    const id = await domainId(jmap, domain);
    if (!id) throw new Error(`${domain} has no mail on the server`);
    return id;
  }

  async function accountsOf(jmap: Jmap, id: string) {
    const rows = await jmap.get<{ name: string; domainId: string; usedDiskQuota?: number }>("x:Account", await jmap.ids("x:Account", { domainId: id }), ["name", "domainId", "usedDiskQuota"]);
    return rows.filter((row) => row.domainId === id);
  }

  /** Mailing lists cannot be filtered by domain: there are few, they are all read. */
  async function listsOf(jmap: Jmap, id: string) {
    const rows = await jmap.get<{ name: string; domainId: string }>("x:MailingList", await jmap.ids("x:MailingList"), ["name", "domainId"]);
    return rows.filter((row) => row.domainId === id);
  }

  async function dkimOf(jmap: Jmap, id: string) {
    const rows = await jmap.get<{ "@type": string; selector: string; domainId: string; publicKey: string; stage: string }>(
      "x:DkimSignature",
      await jmap.ids("x:DkimSignature"),
      ["@type", "selector", "domainId", "publicKey", "stage"],
    );
    return rows.filter((row) => row.domainId === id);
  }

  /** Certificates that cover `name`: the current one, and any left over by an interrupted replacement. */
  async function certificatesOf(jmap: Jmap, name: string) {
    const rows = await jmap.get<{ subjectAlternativeNames?: Record<string, boolean>; certificate?: { value?: string } }>(
      "x:Certificate",
      await jmap.ids("x:Certificate"),
      ["subjectAlternativeNames", "certificate"],
    );
    return rows.filter((row) => row.subjectAlternativeNames?.[name] === true);
  }

  /** Stalwart picks the certificate by SNI. Measured on 1.2: a new one is used only after ReloadTlsCertificates. */
  const reloadCertificates = (jmap: Jmap) => jmap.set("x:Action", { create: { r: { "@type": "ReloadTlsCertificates" } } });

  const defaultCertificateId = async (jmap: Jmap) => {
    const [settings] = await jmap.request([["x:SystemSettings/get", { ids: ["singleton"], properties: ["defaultCertificateId"] }]]);
    return ((settings!.list as { defaultCertificateId?: string | null }[] | undefined) ?? [])[0]?.defaultCertificateId ?? null;
  };

  /**
   * The new one first, then the old ones go: there is always one to serve. `asDefault`: it is also the one served
   * without SNI (pointed to before the old one is destroyed, which Stalwart would refuse while it is linked).
   */
  async function installCertificate(jmap: Jmap, name: string, certPem: string, keyPem: string, asDefault = false): Promise<boolean> {
    const current = await certificatesOf(jmap, name);
    // The server name can also be mail.<domain> of a domain with mail: renewing it from there keeps it the default.
    const currentDefault = await defaultCertificateId(jmap);
    if (current.some((row) => row.id === currentDefault)) asDefault = true;
    if (current.length === 1 && current[0]!.certificate?.value === certPem && (!asDefault || currentDefault === current[0]!.id)) return false;
    let id = current.length === 1 && current[0]!.certificate?.value === certPem ? current[0]!.id : null;
    if (!id) {
      const created = await jmap.set("x:Certificate", {
        create: { c: { certificate: { "@type": "Text", value: certPem }, privateKey: { "@type": "Text", secret: keyPem } } },
      });
      id = created.created!.c!.id;
    }
    if (asDefault) await jmap.set("x:SystemSettings", { update: { singleton: { defaultCertificateId: id } } });
    const old = current.filter((row) => row.id !== id).map((row) => row.id);
    if (old.length > 0) await jmap.set("x:Certificate", { destroy: old });
    await reloadCertificates(jmap);
    return true;
  }

  async function serverHostname(jmap: Jmap): Promise<string> {
    const [settings] = await jmap.request([["x:SystemSettings/get", { ids: ["singleton"], properties: ["defaultHostname"] }]]);
    const hostname = ((settings!.list as { defaultHostname?: string }[] | undefined) ?? [])[0]?.defaultHostname ?? "";
    if (!hostname || hostname.endsWith(".invalid")) {
      throw new Error("The server has no mail name yet: run the installer with --mail-hostname mail.yourserver.com");
    }
    return hostname;
  }

  async function removeCertificate(jmap: Jmap, host: Host, domain: string) {
    const name = mailHostOf(domain);
    // It is also the server name: its certificate stays.
    const [settings] = await jmap.request([["x:SystemSettings/get", { ids: ["singleton"], properties: ["defaultHostname"] }]]);
    if (((settings!.list as { defaultHostname?: string }[] | undefined) ?? [])[0]?.defaultHostname === name) return;
    const current = await certificatesOf(jmap, name);
    if (current.length > 0) {
      await jmap.set("x:Certificate", { destroy: current.map((row) => row.id) });
      await reloadCertificates(jmap);
    }
    await forgetCertificate(host, name);
  }

  const handlers = {
    "mail.status": async (_params: AgentOpParams<"mail.status">, host: Host): Promise<AgentOpResult<"mail.status">> => {
      if (host.sandbox) return { installed: true, running: true, hostname: "mail.sandbox.test", webmail: true };
      // Turned off with `eagle mail off`, the binary and the data stay: what counts is whether the service is enabled.
      const installed = (await host.run("test", ["-x", STALWART_BIN])).code === 0
        && (await host.run("systemctl", ["is-enabled", "--quiet", "stalwart"])).code === 0;
      if (!installed) return { installed, running: false, hostname: null, webmail: false };
      // Its configuration is written last by the installer: without it Roundcube is not ready.
      const webmail = (await host.readFile(`${ROUNDCUBE_CONFIG_DIR}/config.inc.php`)) !== null
        && (await host.run("test", ["-f", `${ROUNDCUBE_DIR}/public_html/index.php`])).code === 0;
      try {
        const [settings] = await jmapFor(host).request([["x:SystemSettings/get", { ids: ["singleton"], properties: ["defaultHostname"] }]]);
        const list = (settings!.list as { defaultHostname?: string }[] | undefined) ?? [];
        return { installed, running: true, hostname: list[0]?.defaultHostname || null, webmail };
      } catch {
        return { installed, running: false, hostname: null, webmail };
      }
    },

    "mail.domain.set": async ({ domain, catchAll }: AgentOpParams<"mail.domain.set">, host: Host): Promise<AgentOpResult<"mail.domain.set">> => {
      if (host.sandbox) return { ok: true };
      const jmap = jmapFor(host);
      const id = await domainId(jmap, domain);
      if (id) await jmap.set("x:Domain", { update: { [id]: { enable: true, catchAllAddress: catchAll } } });
      else await jmap.set("x:Domain", { create: { d: { name: domain, enable: true, catchAllAddress: catchAll } } });
      return { ok: true };
    },

    "mail.domain.remove": async ({ domain }: AgentOpParams<"mail.domain.remove">, host: Host): Promise<AgentOpResult<"mail.domain.remove">> => {
      if (host.sandbox) return { ok: true };
      const jmap = jmapFor(host);
      const id = await domainId(jmap, domain);
      if (!id) return { ok: true };
      // Stalwart refuses to delete a domain anything still points to.
      const accounts = (await accountsOf(jmap, id)).map((row) => row.id);
      if (accounts.length > 0) await jmap.set("x:Account", { destroy: accounts });
      const lists = (await listsOf(jmap, id)).map((row) => row.id);
      if (lists.length > 0) await jmap.set("x:MailingList", { destroy: lists });
      const keys = (await dkimOf(jmap, id)).map((row) => row.id);
      if (keys.length > 0) await jmap.set("x:DkimSignature", { destroy: keys });
      // The default domain of the server (its own) stays: Stalwart needs one.
      const [settings] = await jmap.request([["x:SystemSettings/get", { ids: ["singleton"], properties: ["defaultDomainId"] }]]);
      const defaultId = ((settings!.list as { defaultDomainId?: string }[] | undefined) ?? [])[0]?.defaultDomainId;
      if (defaultId !== id) await jmap.set("x:Domain", { destroy: [id] });
      await removeCertificate(jmap, host, domain);
      return { ok: true };
    },

    "mail.cert.issue": async ({ domain }: AgentOpParams<"mail.cert.issue">, host: Host): Promise<AgentOpResult<"mail.cert.issue">> => {
      if (host.sandbox) return { notAfter: Date.now() + 90 * 24 * 3600 * 1000, renewed: false };
      const jmap = jmapFor(host);
      await requireDomain(jmap, domain);
      const name = mailHostOf(domain);
      const issued = await obtainCertificate(host, name);
      // Also when lego did not renew: Stalwart may not have it yet (a previous attempt failed after lego).
      const installed = await installCertificate(jmap, name, issued.certPem, issued.keyPem);
      return { notAfter: issued.notAfter, renewed: issued.renewed || installed };
    },

    "mail.server.cert.issue": async (_params: AgentOpParams<"mail.server.cert.issue">, host: Host): Promise<AgentOpResult<"mail.server.cert.issue">> => {
      if (host.sandbox) return { hostname: "mail.sandbox.test", notAfter: Date.now() + 90 * 24 * 3600 * 1000, renewed: false };
      const jmap = jmapFor(host);
      const hostname = await serverHostname(jmap);
      const issued = await obtainCertificate(host, hostname);
      const installed = await installCertificate(jmap, hostname, issued.certPem, issued.keyPem, true);
      return { hostname, notAfter: issued.notAfter, renewed: issued.renewed || installed };
    },

    "mail.server.hostname.set": async ({ hostname }: AgentOpParams<"mail.server.hostname.set">, host: Host): Promise<AgentOpResult<"mail.server.hostname.set">> => {
      if (host.sandbox) return { ok: true };
      const jmap = jmapFor(host);
      // Same rule as the installer: mail.example.com belongs to example.com.
      const labels = hostname.split(".");
      const serverDomain = labels.length > 2 ? labels.slice(1).join(".") : hostname;
      let id = await domainId(jmap, serverDomain);
      if (!id) id = (await jmap.set("x:Domain", { create: { d: { name: serverDomain, enable: true } } })).created!.d!.id;
      await jmap.set("x:SystemSettings", { update: { singleton: { defaultHostname: hostname, defaultDomainId: id } } });
      // Measured on 1.2: without it, SMTP keeps greeting with the previous name until a restart.
      await jmap.set("x:Action", { create: { s: { "@type": "ReloadSettings" } } });
      const conf = (await host.readFile(INSTALL_CONF)) ?? "";
      const lines = conf.split("\n").filter((line) => !line.startsWith("MAIL_HOSTNAME="));
      while (lines.length > 0 && lines.at(-1) === "") lines.pop();
      await host.writeFileAtomic(INSTALL_CONF, `${[...lines, `MAIL_HOSTNAME=${hostname}`].join("\n")}\n`, 0o600);
      return { ok: true };
    },

    "mail.server.outbound": async (_params: AgentOpParams<"mail.server.outbound">, host: Host): Promise<AgentOpResult<"mail.server.outbound">> => {
      if (host.sandbox) return { port25: true };
      return { port25: await canReachPort25() };
    },

    "mail.domain.dkim": async ({ domain }: AgentOpParams<"mail.domain.dkim">, host: Host): Promise<AgentOpResult<"mail.domain.dkim">> => {
      if (host.sandbox) {
        return { keys: [{ selector: "v1-ed25519-sandbox", algorithm: "ed25519", publicKey: "c2FuZGJveA==" }] };
      }
      const jmap = jmapFor(host);
      const id = await requireDomain(jmap, domain);
      const keys: DkimKey[] = (await dkimOf(jmap, id))
        .filter((row) => row.stage === "active" && row.publicKey)
        .map((row) => ({ selector: row.selector, algorithm: row["@type"].includes("Ed25519") ? "ed25519" : "rsa", publicKey: row.publicKey }));
      keys.sort((a, b) => a.selector.localeCompare(b.selector));
      return { keys };
    },

    "mail.mailbox.set": async ({ domain, name, password, quotaMb, aliases }: AgentOpParams<"mail.mailbox.set">, host: Host): Promise<AgentOpResult<"mail.mailbox.set">> => {
      if (host.sandbox) return { ok: true };
      const jmap = jmapFor(host);
      const id = await requireDomain(jmap, domain);
      const existing = (await accountsOf(jmap, id)).find((row) => row.name === name);
      const value: Args = {
        quotas: { maxDiskQuota: quotaMb * MB },
        aliases: Object.fromEntries(aliases.map((alias, index) => [String(index), { name: alias, domainId: id }])),
        ...(password ? { credentials: { "0": { "@type": "Password", secret: password } } } : {}),
      };
      if (existing) {
        await jmap.set("x:Account", { update: { [existing.id]: value } });
      } else {
        if (!password) throw new Error(`${name}@${domain} does not exist: a password is needed to create it`);
        await jmap.set("x:Account", { create: { a: { "@type": "User", name, domainId: id, ...value } } });
      }
      return { ok: true };
    },

    "mail.import.scan": async (params: AgentOpParams<"mail.import.scan">, host: Host): Promise<AgentOpResult<"mail.import.scan">> => {
      return { mailboxes: await scanBackup(host, params) };
    },

    "mail.import.account": async ({ importId, domain, name, quotaMb, password }: AgentOpParams<"mail.import.account">, host: Host): Promise<AgentOpResult<"mail.import.account">> => {
      const hash = await backupPasswordHash(host, importId, domain, name);
      if (host.sandbox) return { passwordKept: hash !== null };
      const jmap = jmapFor(host);
      const id = await requireDomain(jmap, domain);
      if ((await accountsOf(jmap, id)).some((row) => row.name === name)) return { passwordKept: false };
      await jmap.set("x:Account", { create: { a: {
        "@type": "User", name, domainId: id, quotas: { maxDiskQuota: quotaMb * MB }, aliases: {},
        credentials: { "0": { "@type": "Password", secret: hash ?? password } },
      } } });
      return { passwordKept: hash !== null };
    },

    "mail.import.run": async ({ domain, name, source, cursor }: AgentOpParams<"mail.import.run">, host: Host): Promise<AgentOpResult<"mail.import.run">> => {
      if (host.sandbox) return { done: true, cursor, imported: 0, skipped: 0 };
      const sink = await sinkFor(host, `${name}@${domain}`);
      if (source.kind === "backup") return importFromBackup(host, sink, { importId: source.importId, domain, name, cursor });
      return importFromImap(sink, source, cursor);
    },

    "mail.import.discard": async ({ importId }: AgentOpParams<"mail.import.discard">, host: Host): Promise<AgentOpResult<"mail.import.discard">> => {
      await discardImport(host, importId);
      return { ok: true };
    },

    "mail.mailbox.remove": async ({ domain, name }: AgentOpParams<"mail.mailbox.remove">, host: Host): Promise<AgentOpResult<"mail.mailbox.remove">> => {
      if (host.sandbox) return { ok: true };
      const jmap = jmapFor(host);
      const id = await domainId(jmap, domain);
      const existing = id ? (await accountsOf(jmap, id)).find((row) => row.name === name) : undefined;
      if (existing) await jmap.set("x:Account", { destroy: [existing.id] });
      return { ok: true };
    },

    "mail.usage": async ({ domain }: AgentOpParams<"mail.usage">, host: Host): Promise<AgentOpResult<"mail.usage">> => {
      if (host.sandbox) return { mailboxes: [] };
      const jmap = jmapFor(host);
      const id = await domainId(jmap, domain);
      if (!id) return { mailboxes: [] };
      return { mailboxes: (await accountsOf(jmap, id)).map((row) => ({ name: row.name, usedBytes: row.usedDiskQuota ?? 0 })) };
    },

    "mail.forwarder.set": async ({ domain, name, recipients }: AgentOpParams<"mail.forwarder.set">, host: Host): Promise<AgentOpResult<"mail.forwarder.set">> => {
      if (host.sandbox) return { ok: true };
      const jmap = jmapFor(host);
      const id = await requireDomain(jmap, domain);
      const existing = (await listsOf(jmap, id)).find((row) => row.name === name);
      const value = { recipients: Object.fromEntries(recipients.map((address) => [address, true])) };
      if (existing) await jmap.set("x:MailingList", { update: { [existing.id]: value } });
      else await jmap.set("x:MailingList", { create: { l: { name, domainId: id, ...value } } });
      return { ok: true };
    },

    "mail.forwarder.remove": async ({ domain, name }: AgentOpParams<"mail.forwarder.remove">, host: Host): Promise<AgentOpResult<"mail.forwarder.remove">> => {
      if (host.sandbox) return { ok: true };
      const jmap = jmapFor(host);
      const id = await domainId(jmap, domain);
      const existing = id ? (await listsOf(jmap, id)).find((row) => row.name === name) : undefined;
      if (existing) await jmap.set("x:MailingList", { destroy: [existing.id] });
      return { ok: true };
    },
  };
  return handlers;
}

/** One client per host: it keeps the credentials read from disk. */
const clients = new WeakMap<Host, Jmap>();
export const mailHandlers = createMailHandlers((host) => {
  let client = clients.get(host);
  if (!client) {
    client = createJmap(host);
    clients.set(host, client);
  }
  return client;
});
