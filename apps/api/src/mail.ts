import {
  certCovers,
  DEFAULT_MAILBOX_QUOTA_MB,
  MAIL_CERT_RENEW_DAYS,
  MAX_MAILBOX_ALIASES,
  MAX_FORWARDER_RECIPIENTS,
  emailAddressSchema,
  fqdnSchema,
  imapSourceSchema,
  isMailReserved,
  mailLocalPartSchema,
  mailImportIdSchema,
  mailImportPathSchema,
  mailQuotaMbSchema,
  webmailHostOf,
  type AgentOpParams,
  type DnsRecordDto,
  type MailCertificateDto,
  type MailDomainDto,
  type MailImportScanDto,
  type ScannedMailboxDto,
  type ServerMailDto,
  type WebmailDto,
} from "@eaglepanel/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AgentClient } from "./agent-client";
import { audit } from "./audit";
import type { Db } from "./db";
import { certificates, domains, hostnames, mailDomains, mailForwarders, mailboxes, settings } from "./db/schema";
import type { JobStep } from "./jobs";
import { checkPtr, checkRecords, expectedRecords, mailHostOf, publicLookup, sameAddress, serverRecords, type DnsLookup } from "./mail-dns";

const catchAllSchema = z.object({ address: emailAddressSchema.nullable() }).strict();
const createMailboxSchema = z.object({ name: mailLocalPartSchema, quotaMb: mailQuotaMbSchema.default(DEFAULT_MAILBOX_QUOTA_MB) }).strict();
const updateMailboxSchema = z.object({
  quotaMb: mailQuotaMbSchema,
  aliases: z.array(mailLocalPartSchema).max(MAX_MAILBOX_ALIASES).refine((list) => new Set(list).size === list.length, "There are repeated aliases"),
}).strict();
const forwarderSchema = z.object({
  name: mailLocalPartSchema,
  recipients: z.array(emailAddressSchema).min(1, "Add at least one recipient").max(MAX_FORWARDER_RECIPIENTS)
    .refine((list) => new Set(list).size === list.length, "There are repeated recipients"),
}).strict();
const updateForwarderSchema = forwarderSchema.pick({ recipients: true });
/** Names only a local network resolves (hostname -f often gives them) never work for mail. */
const LOCAL_SUFFIX = /\.(localdomain|localhost|local|lan|internal|home|intranet|corp|private|invalid)$/;
const serverHostnameSchema = z.object({
  hostname: fqdnSchema.transform((value) => value.toLowerCase()).refine((value) => !LOCAL_SUFFIX.test(value), "Use a name of a real domain, like mail.yourdomain.com"),
}).strict();

/** Public DNS answers are cached this long per domain: the page polls while a job runs. */
const DNS_CACHE_MS = 30_000;

/** The browser sends uploads in pieces of 32 MB: this leaves room. */
const MAX_UPLOAD_PIECE = 100 * 1024 * 1024;
const generateSecret = () => randomBytes(24).toString("base64url");

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Let's Encrypt allows 5 failed validations per name and hour: after a failure the panel waits this long by itself. */
const CERT_RETRY_MS = 3 * HOUR;
const CERT_SCAN_MS = HOUR;
/** Whether port 25 goes out changes only if the provider changes it: checked a few times a day, or on request. */
const OUTBOUND_CACHE_MS = 6 * HOUR;
const SERVER_CERT = "@server";
const SERVER_CERT_KEY = "mail_server_certificate";

interface CertificateState {
  notAfter: number | null;
  error: string | null;
  attemptAt: number | null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface MailRouteDeps {
  db: Db;
  agent: AgentClient;
  readBody: <S extends z.ZodType>(c: Context, schema: S) => Promise<{ data: z.infer<S> } | { error: string }>;
  startJob: (c: Context, type: string, title: string, steps: JobStep[], detail: string, secret?: string) => Response | Promise<Response>;
  /** Overridable in tests: the public DNS. */
  lookup?: DnsLookup;
  /** OLS publishes the mail names on port 80 for the certificate validation: after enabling or disabling mail. */
  syncSites: () => Promise<void>;
}

export function registerMailRoutes(routes: Hono, { db, agent, readBody, startJob, lookup = publicLookup(), syncSites }: MailRouteDeps) {
  const dnsCache = new Map<string, { at: number; records: DnsRecordDto[] }>();

  const domainRow = (username: string, zone: string) => db.select().from(domains).where(and(eq(domains.fqdn, zone), eq(domains.username, username))).get();
  const mailRow = (zone: string) => db.select().from(mailDomains).where(eq(mailDomains.domain, zone)).get();
  const mailboxRows = (zone: string) => db.select().from(mailboxes).where(eq(mailboxes.domain, zone)).orderBy(asc(mailboxes.name)).all();
  const forwarderRows = (zone: string) => db.select().from(mailForwarders).where(eq(mailForwarders.domain, zone)).orderBy(asc(mailForwarders.name)).all();
  const mailboxRow = (zone: string, name: string) => db.select().from(mailboxes).where(eq(mailboxes.address, `${name}@${zone}`)).get();
  const forwarderRow = (zone: string, name: string) => db.select().from(mailForwarders).where(eq(mailForwarders.address, `${name}@${zone}`)).get();

  /** Who already answers for `name@zone`: a mailbox, an alias of one, or a forwarder. */
  function addressOwner(zone: string, name: string, except?: string): string | null {
    for (const row of mailboxRows(zone)) {
      if (row.address === except) continue;
      if (row.name === name) return row.address;
      if (row.aliases.includes(name)) return row.address;
    }
    const forwarder = forwarderRows(zone).find((row) => row.name === name && row.address !== except);
    return forwarder?.address ?? null;
  }

  /** From the URL; null if the domain is not the account's, or (with `withMail`) has no mail. */
  function target(c: Context, withMail = true): { username: string; zone: string } | null {
    const username = c.req.param("username") ?? "";
    const zone = c.req.param("zone") ?? "";
    if (!domainRow(username, zone)) return null;
    if (withMail && !mailRow(zone)) return null;
    return { username, zone };
  }

  // ---------------------------------------------------------------- Certificates: mail.<domain> and the server name
  /** One at a time: they share the validation port, and Let's Encrypt is not hurried. */
  let certChain: Promise<unknown> = Promise.resolve();
  /** Domains being requested; SERVER_CERT for the server name. */
  const certInFlight = new Set<string>();

  const certificateDue = (state: { notAfter: number | null }) => state.notAfter === null || state.notAfter - Date.now() < MAIL_CERT_RENEW_DAYS * DAY;
  const recentlyFailed = (state: CertificateState) => state.error !== null && state.attemptAt !== null && Date.now() - state.attemptAt < CERT_RETRY_MS;

  const publicIps = () => agent.call("system.publicIp", {}).catch(() => ({ ip: null, ip6: null }));

  /**
   * The validation connects to the address of the name: it has to be this server's. An AAAA elsewhere would be tried
   * first, so it has to be this server's too, or not be there.
   */
  async function pointsHere(name: string): Promise<boolean> {
    const { ip, ip6 } = await publicIps();
    if (!ip && !ip6) return false;
    const [a, aaaa] = await Promise.all([lookup.a(name), lookup.aaaa(name)].map((query) => query.catch(() => [] as string[])));
    const matches = (found: string[], own: string | null) => own !== null && found.some((value) => sameAddress(value, own));
    if (aaaa!.length > 0 && !matches(aaaa!, ip6)) return false;
    return matches(a!, ip) || matches(aaaa!, ip6);
  }

  function queueCertificate(key: string, task: () => Promise<void>): Promise<void> {
    const run = certChain.then(async () => {
      certInFlight.add(key);
      try {
        await task();
      } finally {
        certInFlight.delete(key);
      }
    });
    certChain = run.catch(() => undefined);
    return run;
  }

  const domainCertificate = (row: typeof mailDomains.$inferSelect): CertificateState => ({ notAfter: row.certNotAfter, error: row.certError, attemptAt: row.certAttemptAt });

  function issueCertificate(zone: string): Promise<void> {
    return queueCertificate(zone, async () => {
      if (!mailRow(zone)) return;
      try {
        const { notAfter } = await agent.call("mail.cert.issue", { domain: zone });
        db.update(mailDomains).set({ certNotAfter: notAfter, certError: null, certAttemptAt: Date.now() }).where(eq(mailDomains.domain, zone)).run();
      } catch (error) {
        db.update(mailDomains).set({ certError: errorText(error), certAttemptAt: Date.now() }).where(eq(mailDomains.domain, zone)).run();
        throw error;
      }
    });
  }

  // The server's: in the settings, as JSON, with the name it is for. The name can also change with the installer
  // (--mail-hostname): what was saved for another name does not count.
  function serverCertificate(hostname: string | null): CertificateState {
    const value = db.select().from(settings).where(eq(settings.key, SERVER_CERT_KEY)).get()?.value;
    const saved = value ? (JSON.parse(value) as CertificateState & { hostname?: string }) : null;
    if (!saved || saved.hostname !== hostname) return { notAfter: null, error: null, attemptAt: null };
    return { notAfter: saved.notAfter, error: saved.error, attemptAt: saved.attemptAt };
  }
  function saveServerCertificate(hostname: string, state: CertificateState) {
    const value = JSON.stringify({ hostname, ...state });
    db.insert(settings).values({ key: SERVER_CERT_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  }

  function issueServerCertificate(hostname: string): Promise<void> {
    return queueCertificate(SERVER_CERT, async () => {
      try {
        const result = await agent.call("mail.server.cert.issue", {});
        saveServerCertificate(result.hostname, { notAfter: result.notAfter, error: null, attemptAt: Date.now() });
      } catch (error) {
        saveServerCertificate(hostname, { ...serverCertificate(hostname), error: errorText(error), attemptAt: Date.now() });
        throw error;
      }
    });
  }

  const logFailure = (name: string) => (error: unknown) => console.error(`[api] certificate of ${name}:`, errorText(error));

  /** By itself: only if it is due, the name already points here, and it did not just fail. */
  async function maybeIssueCertificate(zone: string) {
    const row = mailRow(zone);
    if (!row || certInFlight.has(zone)) return;
    const state = domainCertificate(row);
    if (!certificateDue(state) || recentlyFailed(state)) return;
    if (!(await pointsHere(mailHostOf(zone)))) return;
    await issueCertificate(zone).catch(logFailure(mailHostOf(zone)));
  }

  async function maybeIssueServerCertificate() {
    if (certInFlight.has(SERVER_CERT)) return;
    const status = await agent.call("mail.status", {}).catch(() => null);
    const hostname = status?.running ? status.hostname : null;
    if (!hostname || hostname.endsWith(".invalid")) return;
    const state = serverCertificate(hostname);
    if (!certificateDue(state) || recentlyFailed(state) || !(await pointsHere(hostname))) return;
    await issueServerCertificate(hostname).catch(logFailure(hostname));
  }

  function certificateDto(key: string, { notAfter, error, attemptAt }: CertificateState, pointed: boolean): MailCertificateDto {
    const now = Date.now();
    const state: MailCertificateDto["state"] = certInFlight.has(key) ? "pending"
      : notAfter !== null && notAfter - now >= MAIL_CERT_RENEW_DAYS * DAY ? "valid"
      : error ? "failed"
      : notAfter !== null && notAfter > now ? "expiring"
      : pointed ? "pending" : "waiting";
    return { state, notAfter, error, attemptAt };
  }

  // ---------------------------------------------------------------- Server mail (Settings)
  let serverCache: { at: number; records: DnsRecordDto[]; ptrs: ServerMailDto["ptrs"] } | null = null;
  let outboundCache: { at: number; port25: boolean } | null = null;

  async function toServerMailDto(refresh: boolean): Promise<ServerMailDto> {
    const status = await agent.call("mail.status", {}).catch(() => null);
    const hostname = status?.hostname ?? null;
    const named = hostname !== null && !hostname.endsWith(".invalid");
    const { ip, ip6 } = await publicIps();
    const empty: ServerMailDto = {
      installed: status?.installed ?? false, running: status?.running ?? false, hostname, named, ip, ip6,
      records: [], ptrs: [], port25: "unknown", checkedAt: null,
      certificate: certificateDto(SERVER_CERT, serverCertificate(hostname), false),
    };
    if (!status?.running || !named) return empty;

    const expected = serverRecords(hostname, ip, ip6);
    const stale = !serverCache || refresh || Date.now() - serverCache.at > DNS_CACHE_MS
      || serverCache.records.length !== expected.length || serverCache.records.some((record, index) => record.value !== expected[index]!.value || record.name !== expected[index]!.name);
    if (stale) {
      const ips = [ip, ip6].filter((value): value is string => value !== null);
      const [records, ptrs] = await Promise.all([
        checkRecords(expected, lookup),
        Promise.all(ips.map(async (value) => ({ ip: value, ...(await checkPtr(value, hostname, lookup)) }))),
      ]);
      serverCache = { at: Date.now(), records, ptrs };
    }
    if (!outboundCache || refresh || Date.now() - outboundCache.at > OUTBOUND_CACHE_MS) {
      const result = await agent.call("mail.server.outbound", {}).catch(() => null);
      outboundCache = result ? { at: Date.now(), port25: result.port25 } : null;
    }
    const pointed = serverCache!.records.some((record) => (record.type === "A" || record.type === "AAAA") && record.state === "ok");
    if (stale && pointed) void maybeIssueServerCertificate();
    return {
      ...empty,
      records: serverCache!.records,
      ptrs: serverCache!.ptrs,
      port25: outboundCache ? (outboundCache.port25 ? "open" : "blocked") : "unknown",
      checkedAt: serverCache!.at,
      certificate: certificateDto(SERVER_CERT, serverCertificate(hostname), pointed),
    };
  }

  routes.get("/settings/mail", async (c) => c.json(await toServerMailDto(c.req.query("refresh") === "1")));

  routes.post("/settings/mail/hostname", async (c) => {
    const body = await readBody(c, serverHostnameSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { hostname } = body.data;
    const status = await agent.call("mail.status", {}).catch(() => null);
    if (!status?.installed) return c.json({ error: "Mail is not installed on this server" }, 409);
    if (!status.running) return c.json({ error: "The mail server is not answering" }, 503);
    if (status.hostname === hostname) return c.json({ error: "It already has that name" }, 409);
    // OLS would answer it for the environment, not for the certificate validation.
    if (db.select().from(hostnames).where(eq(hostnames.fqdn, hostname)).get()) return c.json({ error: `${hostname} is used by an environment: choose another name` }, 409);
    return startJob(c, "mail.serverHostname", `Name the mail server ${hostname}`, [{
      name: "Apply to the mail server and to the installer settings",
      run: async () => {
        await agent.call("mail.server.hostname.set", { hostname });
        // The certificate was for the previous name.
        db.delete(settings).where(eq(settings.key, SERVER_CERT_KEY)).run();
        serverCache = null;
      },
      compensate: async () => {
        if (status.hostname && !status.hostname.endsWith(".invalid")) await agent.call("mail.server.hostname.set", { hostname: status.hostname });
      },
    }, {
      name: `Publish ${hostname} on port 80 for its certificate`,
      run: () => syncSites(),
    }], `${status.hostname ?? "-"} → ${hostname}`);
  });

  routes.post("/settings/mail/certificate", async (c) => {
    const status = await agent.call("mail.status", {}).catch(() => null);
    const hostname = status?.running ? status.hostname : null;
    if (!hostname || hostname.endsWith(".invalid")) return c.json({ error: "The server has no mail name: run the installer with --mail-hostname mail.yourserver.com" }, 409);
    if (certInFlight.has(SERVER_CERT)) return c.json({ error: "The certificate is being requested right now" }, 409);
    if (!(await pointsHere(hostname))) return c.json({ error: `${hostname} does not point to this server yet: create its A record (DNS only) first` }, 409);
    return startJob(c, "mail.serverCertificate", `Get the certificate of ${hostname}`, [{
      name: "Validate with Let's Encrypt and install it on the mail server",
      run: () => issueServerCertificate(hostname),
    }], hostname);
  });

  async function toMailDomainDto(zone: string, refresh: boolean): Promise<MailDomainDto> {
    const row = mailRow(zone);
    const mailHost = mailHostOf(zone);
    if (!row) {
      const status = await agent.call("mail.status", {}).catch(() => null);
      return {
        domain: zone, enabled: false, available: status?.installed ?? false, catchAll: null, mailboxes: [], forwarders: [], mailHost, records: [], checkedAt: null, serverError: null,
        certificate: { state: "waiting", notAfter: null, error: null, attemptAt: null },
        webmail: { url: `https://${webmailHostOf(zone)}/`, state: "not_installed" },
      };
    }
    let serverError: string | null = null;
    let usage = new Map<string, number>();
    let dkim: Awaited<ReturnType<typeof agent.call<"mail.domain.dkim">>>["keys"] = [];
    try {
      usage = new Map((await agent.call("mail.usage", { domain: zone })).mailboxes.map(({ name, usedBytes }) => [name, usedBytes]));
      dkim = (await agent.call("mail.domain.dkim", { domain: zone })).keys;
    } catch (error) {
      serverError = error instanceof Error ? error.message : "The mail server is not answering";
    }
    const { ip, ip6 } = await publicIps();

    let cached = dnsCache.get(zone);
    const expected = expectedRecords(zone, ip, dkim, ip6);
    const stale = !cached || refresh || Date.now() - cached.at > DNS_CACHE_MS
      || cached.records.length !== expected.length || cached.records.some((record, index) => record.value !== expected[index]!.value);
    if (stale) {
      cached = { at: Date.now(), records: await checkRecords(expected, lookup) };
      dnsCache.set(zone, cached);
    }
    const pointed = cached!.records.some((record) => (record.type === "A" || record.type === "AAAA") && record.name === mailHost && record.state === "ok");
    // The name has just been pointed here: no need to wait for the hourly round.
    if (stale && pointed && !serverError) void maybeIssueCertificate(zone);

    return {
      domain: zone,
      enabled: true,
      available: true,
      catchAll: row.catchAll,
      mailboxes: mailboxRows(zone).map((box) => ({
        address: box.address,
        name: box.name,
        quotaMb: box.quotaMb,
        usedBytes: serverError ? null : (usage.get(box.name) ?? 0),
        aliases: box.aliases,
        passwordChangedAt: box.passwordChangedAt,
      })),
      forwarders: forwarderRows(zone).map(({ address, name, recipients }) => ({ address, name, recipients })),
      mailHost,
      records: cached!.records,
      checkedAt: cached!.at,
      serverError,
      certificate: certificateDto(zone, domainCertificate(mailRow(zone) ?? row), pointed),
      webmail: await webmailOf(zone),
    };
  }

  async function webmailOf(zone: string): Promise<WebmailDto> {
    const url = `https://${webmailHostOf(zone)}/`;
    const status = await agent.call("mail.status", {}).catch(() => null);
    if (!status?.webmail) return { url, state: "not_installed" };
    return { url, state: webmailCertificate(db, zone) ? "ready" : "no_certificate" };
  }

  routes.get("/accounts/:username/domains/:zone/mail", async (c) => {
    const found = target(c, false);
    if (!found) return c.json({ error: "Not found" }, 404);
    return c.json(await toMailDomainDto(found.zone, c.req.query("refresh") === "1"));
  });

  routes.post("/accounts/:username/domains/:zone/mail/enable", async (c) => {
    const found = target(c, false);
    if (!found) return c.json({ error: "Not found" }, 404);
    const { username, zone } = found;
    if (mailRow(zone)) return c.json({ error: "The domain already has mail" }, 409);
    // Its mail names must be free: an environment there would take the place of webmail or MTA-STS.
    const taken = db.select().from(hostnames).where(eq(hostnames.domain, zone)).all().filter((row) => isMailReserved(row.fqdn, zone)).map(({ fqdn }) => fqdn);
    if (taken.length > 0) return c.json({ error: `First delete these subdomains, mail uses them: ${taken.join(", ")}` }, 409);
    const status = await agent.call("mail.status", {}).catch(() => null);
    if (!status?.installed) return c.json({ error: "Mail is not installed on this server" }, 409);
    if (!status.running) return c.json({ error: "The mail server is not answering" }, 503);

    return startJob(c, "mail.enable", `Enable mail on ${zone}`, [{
      name: "Create the domain on the mail server",
      run: async () => {
        await agent.call("mail.domain.set", { domain: zone, catchAll: null });
        db.insert(mailDomains).values({ domain: zone, username, catchAll: null, createdAt: Date.now() }).run();
      },
      compensate: async () => {
        db.delete(mailDomains).where(eq(mailDomains.domain, zone)).run();
        await agent.call("mail.domain.remove", { domain: zone });
      },
    }, {
      name: `Publish ${mailHostOf(zone)} on port 80 for its certificate`,
      run: () => syncSites(),
      compensate: () => syncSites(),
    }], `${username}: ${zone}`);
  });

  routes.post("/accounts/:username/domains/:zone/mail/disable", (c) => {
    const found = target(c);
    if (!found) return c.json({ error: "Not found" }, 404);
    const { username, zone } = found;
    // No compensation: the mailboxes and their mail are gone.
    return startJob(c, "mail.disable", `Disable mail on ${zone}`, [{
      name: "Delete the mailboxes, forwarders and the domain from the mail server",
      run: async () => {
        await agent.call("mail.domain.remove", { domain: zone });
        dnsCache.delete(zone);
        db.delete(mailDomains).where(eq(mailDomains.domain, zone)).run();
      },
    }, {
      name: `Stop publishing ${mailHostOf(zone)} on port 80`,
      run: () => syncSites(),
    }], `${username}: ${zone}`);
  });

  routes.post("/accounts/:username/domains/:zone/mail/certificate", async (c) => {
    const found = target(c);
    if (!found) return c.json({ error: "Not found" }, 404);
    const { username, zone } = found;
    const mailHost = mailHostOf(zone);
    if (certInFlight.has(zone)) return c.json({ error: "The certificate is being requested right now" }, 409);
    if (!(await pointsHere(mailHost))) return c.json({ error: `${mailHost} does not point to this server yet: create its A record (DNS only) first` }, 409);
    return startJob(c, "mail.certificate", `Get the certificate of ${mailHost}`, [{
      name: "Validate with Let's Encrypt and install it on the mail server",
      run: () => issueCertificate(zone),
    }], `${username}: ${mailHost}`);
  });

  routes.post("/accounts/:username/domains/:zone/mail/catch-all", async (c) => {
    const found = target(c);
    if (!found) return c.json({ error: "Not found" }, 404);
    const { username, zone } = found;
    const body = await readBody(c, catchAllSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { address } = body.data;
    const previous = mailRow(zone)!.catchAll;
    const apply = async (value: string | null) => {
      await agent.call("mail.domain.set", { domain: zone, catchAll: value });
      db.update(mailDomains).set({ catchAll: value }).where(eq(mailDomains.domain, zone)).run();
    };
    return startJob(c, "mail.catchAll", address ? `Send unknown addresses of ${zone} to ${address}` : `Reject unknown addresses of ${zone}`, [{
      name: "Apply to the mail server",
      run: () => apply(address),
      compensate: () => apply(previous),
    }], `${username}: ${zone} → ${address ?? "-"}`);
  });

  routes.post("/accounts/:username/domains/:zone/mail/mailboxes", async (c) => {
    const found = target(c);
    if (!found) return c.json({ error: "Not found" }, 404);
    const { username, zone } = found;
    const body = await readBody(c, createMailboxSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { name, quotaMb } = body.data;
    const owner = addressOwner(zone, name);
    if (owner) return c.json({ error: `${name}@${zone} is already used by ${owner}` }, 409);

    const address = `${name}@${zone}`;
    const password = generateSecret();
    return startJob(c, "mail.mailbox.create", `Create mailbox ${address}`, [{
      name: "Create the mailbox",
      run: async () => {
        await agent.call("mail.mailbox.set", { domain: zone, name, password, quotaMb, aliases: [] });
        const now = Date.now();
        db.insert(mailboxes).values({ address, domain: zone, name, quotaMb, aliases: [], passwordChangedAt: now, createdAt: now }).run();
      },
      compensate: async () => {
        db.delete(mailboxes).where(eq(mailboxes.address, address)).run();
        await agent.call("mail.mailbox.remove", { domain: zone, name });
      },
    }], `${username}: ${address}`, password);
  });

  routes.post("/accounts/:username/domains/:zone/mail/mailboxes/:name", async (c) => {
    const found = target(c);
    const box = found && mailboxRow(found.zone, c.req.param("name"));
    if (!found || !box) return c.json({ error: "Not found" }, 404);
    const { username, zone } = found;
    const body = await readBody(c, updateMailboxSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { quotaMb, aliases } = body.data;
    for (const alias of aliases) {
      if (alias === box.name) return c.json({ error: "An alias cannot be the mailbox name itself" }, 400);
      const owner = addressOwner(zone, alias, box.address);
      if (owner) return c.json({ error: `${alias}@${zone} is already used by ${owner}` }, 409);
    }
    const apply = async (value: { quotaMb: number; aliases: string[] }) => {
      await agent.call("mail.mailbox.set", { domain: zone, name: box.name, ...value });
      db.update(mailboxes).set(value).where(eq(mailboxes.address, box.address)).run();
    };
    return startJob(c, "mail.mailbox.update", `Update mailbox ${box.address}`, [{
      name: "Apply to the mail server",
      run: () => apply({ quotaMb, aliases }),
      compensate: () => apply({ quotaMb: box.quotaMb, aliases: box.aliases }),
    }], `${username}: ${box.address}`);
  });

  routes.post("/accounts/:username/domains/:zone/mail/mailboxes/:name/password", (c) => {
    const found = target(c);
    const box = found && mailboxRow(found.zone, c.req.param("name"));
    if (!found || !box) return c.json({ error: "Not found" }, 404);
    const password = generateSecret();
    return startJob(c, "mail.mailbox.password", `Regenerate password of ${box.address}`, [{
      name: "Change the password",
      run: async () => {
        await agent.call("mail.mailbox.set", { domain: found.zone, name: box.name, password, quotaMb: box.quotaMb, aliases: box.aliases });
        db.update(mailboxes).set({ passwordChangedAt: Date.now() }).where(eq(mailboxes.address, box.address)).run();
      },
    }], `${found.username}: ${box.address}`, password);
  });

  routes.post("/accounts/:username/domains/:zone/mail/mailboxes/:name/delete", (c) => {
    const found = target(c);
    const box = found && mailboxRow(found.zone, c.req.param("name"));
    if (!found || !box) return c.json({ error: "Not found" }, 404);
    return startJob(c, "mail.mailbox.delete", `Delete mailbox ${box.address}`, [{
      name: "Delete the mailbox and its mail",
      run: async () => {
        await agent.call("mail.mailbox.remove", { domain: found.zone, name: box.name });
        db.delete(mailboxes).where(eq(mailboxes.address, box.address)).run();
      },
    }], `${found.username}: ${box.address}`);
  });

  routes.post("/accounts/:username/domains/:zone/mail/forwarders", async (c) => {
    const found = target(c);
    if (!found) return c.json({ error: "Not found" }, 404);
    const { username, zone } = found;
    const body = await readBody(c, forwarderSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { name, recipients } = body.data;
    const address = `${name}@${zone}`;
    const owner = addressOwner(zone, name);
    if (owner) return c.json({ error: `${address} is already used by ${owner}` }, 409);
    if (recipients.includes(address)) return c.json({ error: "A forwarder cannot send to itself" }, 400);

    return startJob(c, "mail.forwarder.create", `Create forwarder ${address}`, [{
      name: "Create the forwarder",
      run: async () => {
        await agent.call("mail.forwarder.set", { domain: zone, name, recipients });
        db.insert(mailForwarders).values({ address, domain: zone, name, recipients, createdAt: Date.now() }).run();
      },
      compensate: async () => {
        db.delete(mailForwarders).where(eq(mailForwarders.address, address)).run();
        await agent.call("mail.forwarder.remove", { domain: zone, name });
      },
    }], `${username}: ${address} → ${recipients.join(", ")}`);
  });

  routes.post("/accounts/:username/domains/:zone/mail/forwarders/:name", async (c) => {
    const found = target(c);
    const forwarder = found && forwarderRow(found.zone, c.req.param("name"));
    if (!found || !forwarder) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, updateForwarderSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { recipients } = body.data;
    if (recipients.includes(forwarder.address)) return c.json({ error: "A forwarder cannot send to itself" }, 400);
    const apply = async (value: string[]) => {
      await agent.call("mail.forwarder.set", { domain: found.zone, name: forwarder.name, recipients: value });
      db.update(mailForwarders).set({ recipients: value }).where(eq(mailForwarders.address, forwarder.address)).run();
    };
    return startJob(c, "mail.forwarder.update", `Update forwarder ${forwarder.address}`, [{
      name: "Apply to the mail server",
      run: () => apply(recipients),
      compensate: () => apply(forwarder.recipients),
    }], `${found.username}: ${forwarder.address} → ${recipients.join(", ")}`);
  });

  routes.post("/accounts/:username/domains/:zone/mail/forwarders/:name/delete", (c) => {
    const found = target(c);
    const forwarder = found && forwarderRow(found.zone, c.req.param("name"));
    if (!found || !forwarder) return c.json({ error: "Not found" }, 404);
    return startJob(c, "mail.forwarder.delete", `Delete forwarder ${forwarder.address}`, [{
      name: "Delete the forwarder",
      run: async () => {
        await agent.call("mail.forwarder.remove", { domain: found.zone, name: forwarder.name });
        db.delete(mailForwarders).where(eq(mailForwarders.address, forwarder.address)).run();
      },
    }], `${found.username}: ${forwarder.address}`);
  });

  // ---------------------------------------------------------------- Importing mail from another server
  /** The cPanel backup read for each domain, until it is imported or discarded. Lost on restart: read it again. */
  const scans = new Map<string, { importId: string; username: string; path: string; mailboxes: Omit<ScannedMailboxDto, "exists">[] }>();

  /** Calls the agent until the copy is complete: each call is a couple of minutes at most. */
  async function copyAll(zone: string, name: string, source: AgentOpParams<"mail.import.run">["source"]): Promise<{ imported: number; skipped: number }> {
    let cursor = { folder: 0, position: 0 };
    let imported = 0;
    let skipped = 0;
    for (;;) {
      const result = await agent.call("mail.import.run", { domain: zone, name, source, cursor });
      imported += result.imported;
      skipped += result.skipped;
      cursor = result.cursor;
      if (result.done) return { imported, skipped };
    }
  }

  /** Files being uploaded for each domain, before they are read: the id of their folder on the server. */
  const uploads = new Map<string, { importId: string; username: string; files: Map<string, number> }>();

  async function discardScan(zone: string) {
    const ids = new Set([scans.get(zone)?.importId, uploads.get(zone)?.importId].filter((id): id is string => !!id));
    scans.delete(zone);
    uploads.delete(zone);
    for (const importId of ids) await agent.call("mail.import.discard", { importId });
  }

  // The body is one piece of the file, as is. The first piece of the first file (offset 0, no id) starts a new upload.
  routes.post("/accounts/:username/domains/:zone/mail/import/upload", async (c) => {
    const found = target(c);
    if (!found || !agent.stream) return c.json({ error: "Not found" }, 404);
    const name = c.req.query("name") ?? "";
    const offset = Number(c.req.query("offset"));
    const id = c.req.query("id");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(tar\.gz|tgz|tar|zip)$/i.test(name)) return c.json({ error: "Upload a .tar.gz, .tgz, .tar or .zip file" }, 400);
    if (!Number.isSafeInteger(offset) || offset < 0) return c.json({ error: "Invalid offset" }, 400);
    const length = Number(c.req.header("content-length") ?? Number.NaN);
    if (!Number.isFinite(length)) return c.json({ error: "The size is missing" }, 411);
    if (length > MAX_UPLOAD_PIECE) return c.json({ error: "Each piece can be up to 100 MB" }, 413);

    let upload = uploads.get(found.zone);
    if (!id) {
      if (offset !== 0) return c.json({ error: "A new upload starts at the beginning of a file" }, 400);
      await discardScan(found.zone);
      upload = { importId: randomBytes(16).toString("hex"), username: found.username, files: new Map() };
      uploads.set(found.zone, upload);
    } else if (!upload || upload.importId !== id || upload.username !== found.username) {
      return c.json({ error: "That upload is no longer here: start it again" }, 409);
    }
    const response = await agent.stream("/mail/import/upload", { id: upload.importId, name, offset: String(offset) }, c.req.raw.body ?? new Blob([]).stream(), length);
    const body = (await response.json().catch(() => null)) as { error?: string; size?: number } | null;
    if (!response.ok || body?.size === undefined) return c.json({ error: body?.error ?? "Upload failed" }, 400);
    upload.files.set(name, body.size);
    return c.json({ importId: upload.importId, size: body.size });
  });

  routes.get("/accounts/:username/domains/:zone/mail/import", (c) => {
    const found = target(c);
    if (!found) return c.json({ error: "Not found" }, 404);
    const scan = scans.get(found.zone);
    if (!scan || scan.username !== found.username) return c.json({ scan: null });
    const existing = new Set(mailboxRows(found.zone).map((row) => row.name));
    const dto: MailImportScanDto = { importId: scan.importId, path: scan.path, mailboxes: scan.mailboxes.map((box) => ({ ...box, exists: existing.has(box.name) })) };
    return c.json({ scan: dto });
  });

  routes.post("/accounts/:username/domains/:zone/mail/import/scan", async (c) => {
    const found = target(c);
    if (!found) return c.json({ error: "Not found" }, 404);
    // Either a path in the account, or the files just uploaded (their upload id).
    const body = await readBody(c, z.union([
      z.object({ path: mailImportPathSchema }).strict(),
      z.object({ upload: mailImportIdSchema }).strict(),
    ]));
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { username, zone } = found;
    const uploaded = "upload" in body.data ? uploads.get(zone) : undefined;
    if ("upload" in body.data && (!uploaded || uploaded.importId !== body.data.upload || uploaded.username !== username || uploaded.files.size === 0)) {
      return c.json({ error: "Those files are no longer here: upload them again" }, 409);
    }
    const path = "path" in body.data ? body.data.path : undefined;
    const label = path ?? [...uploaded!.files.keys()].join(", ");
    const importId = uploaded?.importId ?? randomBytes(16).toString("hex");
    return startJob(c, "mail.import.scan", `Read the cPanel backup ${label}`, [{
      name: `Look for the mail of ${zone}`,
      run: async () => {
        // A previous backup of the domain goes, except the files this one is made of.
        const previous = scans.get(zone);
        scans.delete(zone);
        if (previous && previous.importId !== importId) await agent.call("mail.import.discard", { importId: previous.importId });
        if (path !== undefined && uploads.get(zone)) await discardScan(zone);
        const { mailboxes: found } = await agent.call("mail.import.scan", { username, domain: zone, importId, ...(path !== undefined ? { path } : {}) });
        scans.set(zone, { importId, username, path: label, mailboxes: found });
      },
      compensate: async () => {
        if (uploads.get(zone)?.importId === importId) uploads.delete(zone);
        await agent.call("mail.import.discard", { importId });
      },
    }], `${username}: ${zone} from ${label}`);
  });

  routes.post("/accounts/:username/domains/:zone/mail/import/discard", async (c) => {
    const found = target(c);
    if (!found) return c.json({ error: "Not found" }, 404);
    await discardScan(found.zone);
    return c.json({ ok: true });
  });

  routes.post("/accounts/:username/domains/:zone/mail/import/backup", async (c) => {
    const found = target(c);
    if (!found) return c.json({ error: "Not found" }, 404);
    const { username, zone } = found;
    const scan = scans.get(zone);
    if (!scan || scan.username !== username) return c.json({ error: "Read the backup first" }, 409);
    const body = await readBody(c, z.object({ mailboxes: z.array(mailLocalPartSchema).min(1).max(1000) }).strict());
    if ("error" in body) return c.json({ error: body.error }, 400);
    const chosen = scan.mailboxes.filter((box) => body.data.mailboxes.includes(box.name));
    if (chosen.length === 0) return c.json({ error: "None of those mailboxes is in the backup" }, 400);
    for (const box of chosen) {
      const owner = addressOwner(zone, box.name);
      // A mailbox with that name gets the messages; a forwarder or an alias with it cannot.
      if (owner && !mailboxRow(zone, box.name)) {
        return c.json({ error: `${box.name}@${zone} is already used by ${owner === `${box.name}@${zone}` ? "a forwarder" : owner}` }, 409);
      }
    }
    const { importId } = scan;
    const steps: JobStep[] = chosen.map((box) => {
      const address = `${box.name}@${zone}`;
      return {
        name: `Import ${address} (${box.messages} messages)`,
        run: async () => {
          if (!mailboxRow(zone, box.name)) {
            // Room for what it brings, and at least what it had in cPanel.
            const needed = Math.ceil((box.bytes * 1.2) / (1024 * 1024)) + 50;
            const quotaMb = Math.max(box.quotaBytes ? Math.ceil(box.quotaBytes / (1024 * 1024)) : DEFAULT_MAILBOX_QUOTA_MB, needed, 10);
            await agent.call("mail.import.account", { importId, domain: zone, name: box.name, quotaMb, password: generateSecret() });
            const now = Date.now();
            db.insert(mailboxes).values({ address, domain: zone, name: box.name, quotaMb, aliases: [], passwordChangedAt: now, createdAt: now }).run();
          }
          const counts = await copyAll(zone, box.name, { kind: "backup", importId });
          audit(db, "mail.import", `${address} from the cPanel backup ${scan.path}: ${counts.imported} imported, ${counts.skipped} already there or skipped`);
        },
      };
    });
    steps.push({ name: "Delete the extracted copy", run: () => discardScan(zone) });
    return startJob(c, "mail.import.backup", `Import mail of ${zone} from the cPanel backup`, steps, `${username}: ${chosen.map((box) => box.name).join(", ")}`);
  });

  routes.post("/accounts/:username/domains/:zone/mail/mailboxes/:name/import", async (c) => {
    const found = target(c);
    const box = found && mailboxRow(found.zone, c.req.param("name"));
    if (!found || !box) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, imapSourceSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const source = { kind: "imap" as const, ...body.data };
    return startJob(c, "mail.import.imap", `Copy mail into ${box.address}`, [{
      name: `Copy ${source.user} from ${source.host}`,
      run: async () => {
        const counts = await copyAll(found.zone, box.name, source);
        audit(db, "mail.import", `${box.address} from ${source.user} at ${source.host}: ${counts.imported} copied, ${counts.skipped} already there or skipped`);
      },
    }], `${found.username}: ${box.address} from ${source.host}`);
  });

  return {
    /** Every hour: certificates that are missing or due, of names that already point here. */
    startCertificateScheduler() {
      const scan = async () => {
        await maybeIssueServerCertificate();
        for (const { domain } of db.select({ domain: mailDomains.domain }).from(mailDomains).all()) await maybeIssueCertificate(domain);
      };
      // A server updated from a version without certificates: its mail names are not on port 80 yet.
      const publish = async () => {
        await syncSites();
      };
      setTimeout(() => void publish().catch((error) => console.error("[api] could not publish the mail names:", error)).then(scan), 60_000).unref?.();
      setInterval(() => void scan(), CERT_SCAN_MS).unref?.();
    },
  };
}

/** Domains with mail among these: deleting them (or their account) must also delete them from Stalwart. */
export const mailDomainsIn = (db: Db, zones: string[]) =>
  zones.filter((zone) => db.select().from(mailDomains).where(eq(mailDomains.domain, zone)).get() !== undefined);

/** A reserved mail name of a domain with mail: it cannot be added as a subdomain nor be used by an environment. */
/**
 * The domain's own certificate, if it covers `webmail.<domain>` (a wildcard does): Roundcube is only published over
 * HTTPS, with the same certificate as the domain's environments.
 */
export function webmailCertificate(db: Db, zone: string): { zone: string; originPull: boolean } | null {
  const row = db.select().from(certificates).where(eq(certificates.zone, zone)).get();
  return row && certCovers(row.names, webmailHostOf(zone)) ? { zone: row.zone, originPull: row.originPull } : null;
}

export function mailReservedConflict(db: Db, fqdn: string): string | null {
  const domain = db.select({ domain: mailDomains.domain }).from(mailDomains).all().find((row) => isMailReserved(fqdn, row.domain));
  return domain ? `${fqdn} is reserved for the mail of ${domain.domain}` : null;
}

