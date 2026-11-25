import {
  ACCOUNT_HOOK_PATH,
  GLOBAL_HOOK_PATH,
  accountLimitsSchema,
  accountServiceSchema,
  certCovers,
  dbNameSchema,
  DEFAULT_LIMITS,
  DEFAULT_LOG_DAYS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PHP_OPTIONS,
  defaultDocRoot,
  docRootSchema,
  fqdnSchema,
  hostnameModeSchema,
  isPublishableDocRoot,
  logDaysSchema,
  logLevelSchema,
  logLinesSchema,
  logSourceSchema,
  pemSchema,
  phpOptionsSchema,
  phpVersionSchema,
  serviceMemorySchema,
  serviceSocket,
  siteDir,
  siteFtpLogin,
  slugify,
  usernameSchema,
  vhostNameSchema,
  vhostSlugSchema,
  type AccountDto,
  type AccountLimits,
  type AccountService,
  type AppDto,
  type DomainDto,
  type HostnameMode,
  type JobCreatedDto,
  type MysqlSettingsDto,
  type ServerSettingsDto,
  type VhostDto,
  mailHostOf,
} from "@eaglepanel/shared";
import { and, asc, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AgentClient } from "./agent-client";
import { audit } from "./audit";
import type { Db } from "./db";
import { registerAppRoutes } from "./apps";
import { createBackups } from "./backups";
import { registerMigrationRoutes } from "./migration";
import { mailDomainsIn, mailReservedConflict, registerMailRoutes, webmailCertificate } from "./mail";
import type { DnsLookup } from "./mail-dns";
import { accounts, appEnv, apps, certificates, databases, deployQueue, domains, hostnames, mailDomains, settings, vhosts } from "./db/schema";
import type { JobRunner, JobStep } from "./jobs";
import type { WebhookDeps } from "./webhooks";

type VhostRow = typeof vhosts.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;
type CertificateRow = typeof certificates.$inferSelect;

/** Domains and environments are added later: the account starts with its user, quota and general FTP. */
const createAccountSchema = z.object({
  username: usernameSchema,
  limits: accountLimitsSchema.default(DEFAULT_LIMITS),
}).strict();
const addDomainSchema = z.object({ domain: fqdnSchema }).strict();
const addHostnameSchema = z.object({ fqdn: fqdnSchema }).strict();
/** Without `slug`, it comes from the name. */
const createVhostSchema = z.object({ name: vhostNameSchema, slug: vhostSlugSchema.optional(), hostname: fqdnSchema, phpVersion: phpVersionSchema }).strict();
const setHostnameSchema = z.object({ hostname: fqdnSchema }).strict();
const addExtraSchema = z.object({ fqdn: fqdnSchema, mode: hostnameModeSchema }).strict();
const renameVhostSchema = z.object({ name: vhostNameSchema, slug: vhostSlugSchema }).strict();
const setPhpSchema = z.object({ phpVersion: phpVersionSchema }).strict();
const deleteAccountSchema = z.object({ confirm: z.string() }).strict();
const certificateSchema = z.object({ certPem: pemSchema, keyPem: pemSchema }).strict();
const createDatabaseSchema = z.object({ name: dbNameSchema }).strict();
const setServiceSchema = z.object({ enabled: z.boolean(), memoryMb: serviceMemorySchema }).strict();
const originPullSchema = z.object({ enabled: z.boolean() }).strict();
const suspendSchema = z.object({ suspended: z.boolean() }).strict();
const vhostOptionsSchema = z.object({ docRoot: docRootSchema, phpVersion: phpVersionSchema, phpOptions: phpOptionsSchema, logLevel: logLevelSchema, logDays: logDaysSchema }).strict();
const logQuerySchema = z.object({ source: logSourceSchema, lines: z.coerce.number().pipe(logLinesSchema).default(200) });

/**
 * OLS drops a leading `www.` when it maps names (measured in WSL: an environment for example.com also answers
 * www.example.com, and mapping only www.example.com also serves example.com). Registering it apart would promise
 * something OLS does not do.
 */
const wwwAlias = (fqdn: string) => (fqdn.startsWith("www.") ? `OpenLiteSpeed already answers for ${fqdn} together with ${fqdn.slice(4)}: add ${fqdn.slice(4)} instead` : null);

/**
 * Changes when what the agent writes for every environment changes, and not for each version. 2026-11-20: the
 * account .ini with open_basedir (OLS ignored php_admin_value) and the OLS configuration in included files.
 */
const SERVER_CONFIG_REVISION = "2026-11-20";
const SERVER_CONFIG_KEY = "server_config_revision";

/** Letters, digits, `-` and `_` only: it can be pasted into any client and needs no escaping. */
const generateSecret = () => randomBytes(24).toString("base64url");


/** Every environment lives in `sites/<slug>`: its FTP access sees only that. */
const newVhost = (row: Pick<VhostRow, "username" | "slug" | "name" | "hostname" | "phpVersion" | "createdAt">): Omit<VhostRow, "id"> => ({
  ...row,
  type: "php",
  docRoot: defaultDocRoot(row.slug),
  phpOptions: DEFAULT_PHP_OPTIONS,
  logLevel: DEFAULT_LOG_LEVEL,
  logDays: DEFAULT_LOG_DAYS,
  ftpPasswordChangedAt: null,
});

const limitsOf = (row: AccountRow): AccountLimits => ({
  quotaMb: row.quotaMb,
  domains: row.maxDomains,
  vhosts: row.maxVhosts,
  databases: row.maxDatabases,
  dbStorageMb: row.dbStorageMb,
  appMemoryMb: row.appMemoryMb,
});

const limitColumns = (limits: AccountLimits) => ({
  quotaMb: limits.quotaMb,
  maxDomains: limits.domains,
  maxVhosts: limits.vhosts,
  maxDatabases: limits.databases,
  dbStorageMb: limits.dbStorageMb,
  appMemoryMb: limits.appMemoryMb,
});

export interface HostingDeps {
  db: Db;
  agent: AgentClient;
  jobs: JobRunner;
  /** The public DNS the mail records are checked against. Tests pass a fake one. */
  dnsLookup?: DnsLookup;
}

async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<{ data: z.infer<S> } | { error: string }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? { data: parsed.data } : { error: parsed.error.issues[0]?.message ?? "Invalid data" };
}

export function createHostingRoutes({ db, agent, jobs, dnsLookup }: HostingDeps) {
  const routes = new Hono();

  const accountRow = (username: string) => db.select().from(accounts).where(eq(accounts.username, username)).get();
  const vhostRow = (id: number) => db.select().from(vhosts).where(eq(vhosts.id, id)).get();
  const vhostBySlug = (slug: string) => db.select().from(vhosts).where(eq(vhosts.slug, slug)).get();
  const vhostByHostname = (fqdn: string) => db.select().from(vhosts).where(eq(vhosts.hostname, fqdn)).get();
  /** From the URL: `/vhosts/:vhost/...`. */
  const vhostOf = (c: Context) => vhostRow(Number(c.req.param("vhost")));
  const accountDomains = (username: string) => db.select().from(domains).where(eq(domains.username, username)).orderBy(asc(domains.createdAt), asc(domains.fqdn)).all();
  const accountVhosts = (username: string) => db.select().from(vhosts).where(eq(vhosts.username, username)).all();
  const appRow = (vhostId: number) => db.select().from(apps).where(eq(apps.vhost, vhostId)).get();
  const accountApps = (username: string) => accountVhosts(username).filter(({ type }) => type === "app").map(({ id }) => appRow(id)).filter((row) => row !== undefined);
  const settingValue = (key: string) => db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
  const hooksDomain = () => settingValue("hooks_domain");
  /** Any panel certificate that covers it: the server-wide domain belongs to no account. */
  const zoneCovering = (fqdn: string) => db.select().from(certificates).all().find((row) => certCovers(row.names, fqdn))?.zone ?? null;
  /** The URLs the account can enter in GitHub: the server-wide one and the one of its own webhook domain. */
  function hookUrls(username: string): string[] {
    const global = hooksDomain();
    const hookVhost = accountRow(username)?.hookVhost;
    const own = hookVhost ? vhostRow(hookVhost)?.hostname : null;
    return [...(global ? [`https://${global}${GLOBAL_HOOK_PATH}`] : []), ...(own ? [`https://${own}${ACCOUNT_HOOK_PATH}`] : [])];
  }

  function toAppDto(vhostId: number): AppDto | null {
    const row = appRow(vhostId);
    if (!row) return null;
    const { kind, repoUrl, branch, subdir, runtime, runtimeVersion, buildCommand, startCommand, outputDir, spaFallback, healthPath, memoryMb } = row;
    return {
      config: { kind, repoUrl, branch, subdir, runtime, runtimeVersion, buildCommand, startCommand, outputDir, spaFallback, healthPath, memoryMb },
      status: row.status,
      currentRelease: row.currentRelease,
      commit: row.commit,
      deployKey: row.deployKey,
      webhook: { secret: row.webhookSecret, urls: hookUrls(vhostRow(vhostId)?.username ?? "") },
      queue: db.select({ id: deployQueue.id, trigger: deployQueue.trigger, commit: deployQueue.commit, requestedAt: deployQueue.requestedAt })
        .from(deployQueue).where(eq(deployQueue.vhost, vhostId)).orderBy(asc(deployQueue.id)).all(),
      env: db.select().from(appEnv).where(eq(appEnv.vhost, vhostId)).orderBy(asc(appEnv.key)).all().map(({ key, value, scope }) => ({ key, value, scope })),
    };
  }
  const accountCerts = (username: string) => db.select().from(certificates).where(eq(certificates.username, username)).all();
  const certificateRow = (zone: string) => db.select().from(certificates).where(eq(certificates.zone, zone)).get();
  const hostnameRow = (fqdn: string) => db.select().from(hostnames).where(eq(hostnames.fqdn, fqdn)).get();
  /** The domain of its hostname: its certificate is the one that applies. */
  const domainOf = (row: Pick<VhostRow, "hostname">) => hostnameRow(row.hostname)?.domain ?? row.hostname;
  const vhostCount = (username: string) => accountVhosts(username).length;

  /** A domain cannot be equal to, the parent of, or a child of another: it would allow publishing under another account's name. */
  function domainConflict(fqdn: string): boolean {
    return db.select({ fqdn: domains.fqdn }).from(domains).all()
      .some((row) => row.fqdn === fqdn || fqdn.endsWith(`.${row.fqdn}`) || row.fqdn.endsWith(`.${fqdn}`));
  }

  /** The certificate of its domain, if it covers its hostname: a single level of subdomain, like the wildcard. */
  function certZoneFor(row: Pick<VhostRow, "hostname">): string | null {
    const certificate = certificateRow(domainOf(row));
    return certificate && certCovers(certificate.names, row.hostname) ? certificate.zone : null;
  }

  /** Without a certificate covering it, the environment is not on 443: there is no connection on which to require it. */
  function originPullFor(row: Pick<VhostRow, "hostname">): boolean {
    return certZoneFor(row) !== null && (certificateRow(domainOf(row))?.originPull ?? false);
  }

  /** Extra names of an environment: aliases and redirects, in alphabetical order. */
  const extrasOf = (vhostId: number) => db.select().from(hostnames).where(eq(hostnames.vhost, vhostId)).all()
    .filter((row): row is typeof row & { mode: HostnameMode } => row.mode !== null)
    .sort((a, b) => a.fqdn.localeCompare(b.fqdn));
  /** The certificate of its own domain covers it: it can also be served on 443. */
  const coveredByItsDomain = (row: { fqdn: string; domain: string }) => {
    const certificate = certificateRow(row.domain);
    return certificate !== undefined && certCovers(certificate.names, row.fqdn);
  };
  /** Where a redirect to this environment goes: over HTTPS if it has a certificate. */
  const redirectTarget = (row: VhostRow) => `${certZoneFor(row) ? "https" : "http"}://${row.hostname}`;

  /** Always reads the database: `ols.sync` receives the full list, so undoing means syncing again. */
  async function syncSites(options: { exclude?: number[]; restart?: boolean } = {}) {
    const excluded = new Set(options.exclude ?? []);
    const rows = db.select().from(vhosts).all().filter(({ id }) => !excluded.has(id));
    const sites = rows.map((row) => {
      const certZone = certZoneFor(row);
      // Only names of its own domain: the vhost has a single certificate.
      const aliases = extrasOf(row.id).filter(({ mode, domain }) => mode === "alias" && domain === domainOf(row))
        .map((extra) => ({ fqdn: extra.fqdn, secure: certZone !== null && coveredByItsDomain(extra) }));
      return { site: row.slug, username: row.username, hostname: row.hostname, certZone, originPull: originPullFor(row), aliases };
    });
    // One redirect vhost per domain, with the certificate of that domain.
    const byDomain = new Map<string, { username: string; hosts: { fqdn: string; secure: boolean; target: string }[] }>();
    for (const row of rows) {
      for (const extra of extrasOf(row.id).filter(({ mode }) => mode === "redirect")) {
        const entry = byDomain.get(extra.domain) ?? { username: row.username, hosts: [] };
        entry.hosts.push({ fqdn: extra.fqdn, secure: coveredByItsDomain(extra), target: redirectTarget(row) });
        byDomain.set(extra.domain, entry);
      }
    }
    const redirects = [...byDomain].map(([domain, { username, hosts }]) => {
      const certificate = certificateRow(domain);
      const certZone = certificate && hosts.some(({ secure }) => secure) ? certificate.zone : null;
      return { domain, certZone, originPull: certZone !== null && certificate!.originPull, suspended: accountRow(username)?.suspended ?? false, hosts };
    });
    const domain = hooksDomain();
    const acmeHosts = db.select({ domain: mailDomains.domain }).from(mailDomains).all().map((row) => mailHostOf(row.domain));
    // The server mail name gets its certificate the same way.
    const mailServer = await agent.call("mail.status", {}).catch(() => null);
    if (mailServer?.hostname && !mailServer.hostname.endsWith(".invalid") && !acmeHosts.includes(mailServer.hostname)) acmeHosts.push(mailServer.hostname);
    // Roundcube for each mail domain whose certificate covers webmail.<domain>: never without HTTPS.
    const webmail = mailServer?.installed && mailServer.webmail
      ? db.select({ domain: mailDomains.domain }).from(mailDomains).all().flatMap(({ domain: zone }) => {
        const certificate = webmailCertificate(db, zone);
        const owner = db.select({ username: domains.username }).from(domains).where(eq(domains.fqdn, zone)).get()?.username;
        return certificate ? [{ domain: zone, certZone: certificate.zone, originPull: certificate.originPull, suspended: owner ? accountRow(owner)?.suspended ?? false : false }] : [];
      })
      : [];
    await agent.call("ols.sync", { sites, redirects, restart: options.restart, hooks: domain ? { fqdn: domain, certZone: zoneCovering(domain) } : null, acmeHosts, webmail });
  }

  async function writeSite(row: VhostRow) {
    const { id, username, slug, docRoot, phpVersion, phpOptions, logLevel, logDays } = row;
    // Read here: any change to an environment of a suspended account must keep showing the 503.
    const suspended = accountRow(username)?.suspended ?? false;
    const appRecord = row.type === "app" ? appRow(id) : undefined;
    const app = !appRecord ? null
      : appRecord.kind === "static"
        ? { kind: "static" as const, id: appRecord.id, release: appRecord.currentRelease, spaFallback: appRecord.spaFallback }
        : { kind: "server" as const, id: appRecord.id };
    const hooks = !suspended && accountRow(username)?.hookVhost === id;
    await agent.call("site.write", { username, site: slug, docRoot, phpVersion, phpOptions, certZone: certZoneFor(row), originPull: originPullFor(row), logLevel, logDays, suspended, app, hooks });
  }

  function toVhostDto(row: VhostRow): VhostDto {
    const { id, slug, name, hostname, username, type, docRoot, phpVersion, phpOptions, logLevel, logDays } = row;
    return {
      id, slug, name, hostname, domain: domainOf(row), type, docRoot, phpVersion, phpOptions, logLevel, logDays,
      certZone: certZoneFor(row),
      extras: extrasOf(id).map((extra) => ({
        fqdn: extra.fqdn,
        mode: extra.mode,
        secure: extra.mode === "alias" ? certZoneFor(row) !== null && coveredByItsDomain(extra) : coveredByItsDomain(extra),
      })),
      app: type === "app" ? toAppDto(id) : null,
      ftp: type === "app" ? null : { login: siteFtpLogin(slug, username), root: siteDir(slug), passwordChangedAt: row.ftpPasswordChangedAt },
    };
  }

  const accountDatabases = (username: string) => db.select().from(databases).where(eq(databases.username, username)).orderBy(asc(databases.name)).all();
  const serviceColumns = (service: AccountService, enabled: boolean, memoryMb: number) =>
    service === "redis" ? { redisEnabled: enabled, redisMemoryMb: memoryMb } : { memcachedEnabled: enabled, memcachedMemoryMb: memoryMb };
  /** The chosen part of the name: `shop` in `acme_shop`. */
  const shortDbName = (username: string, database: string) => database.slice(username.length + 1);

  /** The apex first, then its subdomains in alphabetical order. */
  function toDomainDto({ fqdn }: { fqdn: string }): DomainDto {
    const certificate = certificateRow(fqdn);
    return {
      fqdn,
      hostnames: db.select().from(hostnames).where(eq(hostnames.domain, fqdn)).all()
        .sort((a, b) => Number(b.fqdn === fqdn) - Number(a.fqdn === fqdn) || a.fqdn.localeCompare(b.fqdn))
        .map((row) => {
          const main = vhostByHostname(row.fqdn);
          const extra = !main && row.vhost !== null && row.mode !== null ? vhostRow(row.vhost) : undefined;
          const vhost = main ?? extra;
          return { fqdn: row.fqdn, vhost: vhost ? { id: vhost.id, name: vhost.name, slug: vhost.slug, mode: main ? "main" as const : row.mode! } : null };
        }),
      certificate: certificate ? { zone: certificate.zone, names: certificate.names, notAfter: certificate.notAfter, originPull: certificate.originPull } : null,
    };
  }

  /** A single job step that only touches the database: domains and hostnames do nothing on the server until assigned. */
  function dbStep(name: string, run: () => void): JobStep {
    return { name, run: async () => run() };
  }

  function toAccountDto(row: AccountRow): AccountDto {
    return {
      username: row.username,
      limits: limitsOf(row),
      suspended: row.suspended,
      createdAt: row.createdAt,
      domains: accountDomains(row.username).map(toDomainDto),
      vhosts: accountVhosts(row.username).map(toVhostDto).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
      databases: accountDatabases(row.username).map(({ name, sizeBytes }) => ({ name, sizeBytes })),
      dbBlocked: row.dbBlocked,
      ftpPasswordChangedAt: row.ftpPasswordChangedAt,
      services: {
        redis: { enabled: row.redisEnabled, memoryMb: row.redisMemoryMb, socket: serviceSocket("redis", row.username) },
        memcached: { enabled: row.memcachedEnabled, memoryMb: row.memcachedMemoryMb, socket: serviceSocket("memcached", row.username) },
      },
      hookVhost: row.hookVhost,
    };
  }

  /** `secret` goes only in this response: neither the job nor the audit log stores it. */
  function startJob(c: Context, type: string, title: string, steps: JobStep[], detail: string, secret?: string) {
    const { id } = jobs.enqueue({ type, title, steps });
    audit(db, type, detail);
    return c.json({ jobId: id, ...(secret ? { secret } : {}) } satisfies JobCreatedDto, 202);
  }

  async function assertPhpAvailable(version: string): Promise<boolean> {
    return (await agent.call("php.versions", {})).versions.includes(version);
  }

  /** Common steps to create an environment: register it, write its configuration and publish it. */
  function vhostSteps(row: Omit<VhostRow, "id">, register: () => void, unregister: () => void): JobStep[] {
    const created = () => {
      const current = vhostBySlug(row.slug);
      if (!current) throw new Error(`${row.slug} is not registered`);
      return current;
    };
    return [
      {
        name: "Register in the panel",
        run: async () => register(),
        compensate: async () => unregister(),
      },
      {
        name: `Create ${row.name} and its directory`,
        run: () => writeSite(created()),
        compensate: async () => {
          await agent.call("site.remove", { site: row.slug });
        },
      },
      {
        name: "Apply to OpenLiteSpeed",
        run: () => syncSites(),
        compensate: async () => {
          const current = vhostBySlug(row.slug);
          await syncSites(current ? { exclude: [current.id] } : {});
        },
      },
    ];
  }

  routes.get("/system/preflight", async (c) => {
    try {
      return c.json(await agent.call("system.preflight", {}));
    } catch {
      return c.json({ error: "The agent is not responding" }, 503);
    }
  });

  routes.get("/php-versions", async (c) => {
    try {
      return c.json(await agent.call("php.versions", {}));
    } catch {
      return c.json({ error: "The agent is not responding" }, 503);
    }
  });

  routes.get("/accounts", (c) => {
    return c.json(db.select().from(accounts).orderBy(asc(accounts.username)).all().map(toAccountDto));
  });

  routes.get("/accounts/:username", (c) => {
    const row = accountRow(c.req.param("username"));
    return row ? c.json(toAccountDto(row)) : c.json({ error: "Not found" }, 404);
  });

  routes.post("/accounts", async (c) => {
    const body = await readBody(c, createAccountSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { username, limits } = body.data;

    if (accountRow(username)) return c.json({ error: "An account with that username already exists" }, 409);

    // Without nosymfollow and quotas, the account would be created without the isolation the panel promises.
    const preflight = await agent.call("system.preflight", {});
    if (!preflight.ok) {
      const failed = preflight.checks.filter((check) => !check.ok).map((check) => check.name).join(", ");
      return c.json({ error: `The server is not ready: ${failed}` }, 409);
    }

    const createdAt = Date.now();
    const ftpPassword = generateSecret();
    return startJob(c, "account.create", `Create account ${username}`, [
      {
        name: "Create user, directories and quota",
        run: async () => {
          await agent.call("account.create", { username, quotaMb: limits.quotaMb });
        },
        compensate: async () => {
          await agent.call("account.delete", { username });
        },
      },
      {
        name: "Register in the panel",
        run: async () => {
          db.insert(accounts).values({ username, ...limitColumns(limits), createdAt }).run();
        },
        compensate: async () => {
          db.delete(accounts).where(eq(accounts.username, username)).run();
        },
      },
      {
        // Undone by the first step: deleting the account also removes its FTP access.
        name: "Create the FTP account",
        run: async () => {
          await agent.call("ftp.setPassword", { username, password: ftpPassword });
          db.update(accounts).set({ ftpPasswordChangedAt: Date.now() }).where(eq(accounts.username, username)).run();
        },
      },
    ], username, ftpPassword);
  });

  routes.post("/accounts/:username/limits", async (c) => {
    const username = c.req.param("username");
    const account = accountRow(username);
    if (!account) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, accountLimitsSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const limits = body.data;

    const domainsUsed = accountDomains(username).length;
    if (limits.domains < domainsUsed) return c.json({ error: `The account already uses ${domainsUsed} domains` }, 409);
    const vhostsUsed = vhostCount(username);
    if (limits.vhosts < vhostsUsed) return c.json({ error: `The account already uses ${vhostsUsed} environments` }, 409);

    return startJob(c, "account.limits", `Change limits of ${username}`, [{
      name: "Apply the limits",
      run: async () => {
        if (limits.quotaMb !== account.quotaMb) await agent.call("account.setQuota", { username, quotaMb: limits.quotaMb });
        db.update(accounts).set(limitColumns(limits)).where(eq(accounts.username, username)).run();
      },
    }], `${username}: ${JSON.stringify(limits)}`);
  });

  routes.post("/accounts/:username/delete", async (c) => {
    const username = c.req.param("username");
    if (!accountRow(username)) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, deleteAccountSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    if (body.data.confirm !== username) return c.json({ error: "The confirmation does not match the username" }, 400);

    const rows = accountVhosts(username);
    const ids = rows.map(({ id }) => id);
    const zones = accountCerts(username).map(({ zone }) => zone);
    const dbNames = accountDatabases(username).map(({ name }) => shortDbName(username, name));
    const appsToRemove = accountApps(username);
    const mailZones = mailDomainsIn(db, accountDomains(username).map(({ fqdn }) => fqdn));

    return startJob(c, "account.delete", `Delete account ${username}`, [
      {
        name: "Remove the environments from OpenLiteSpeed",
        run: () => syncSites({ exclude: ids }),
        compensate: () => syncSites(),
      },
      {
        name: "Delete the environments' configuration",
        run: async () => {
          for (const row of rows) await agent.call("site.remove", { site: row.slug });
        },
        compensate: async () => {
          for (const row of rows) await writeSite(row);
        },
      },
      {
        // No compensation: from here on the data can no longer be recovered.
        name: "Delete the databases, the user and its files",
        run: async () => {
          for (const name of dbNames) await agent.call("db.delete", { username, name });
          for (const app of appsToRemove) await agent.call("app.remove", { appId: app.id, username });
          await agent.call("account.delete", { username });
          for (const domain of mailZones) await agent.call("mail.domain.remove", { domain });
          for (const zone of zones) await agent.call("cert.remove", { zone });
          await backups.dropExportsOf(username);
          db.delete(accounts).where(eq(accounts.username, username)).run();
          // Its mail names stop answering the certificate validation.
          if (mailZones.length > 0) await syncSites();
        },
      },
      backups.purgeStep(username),
    ], username);
  });

  routes.post("/accounts/:username/domains", async (c) => {
    const username = c.req.param("username");
    const account = accountRow(username);
    if (!account) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, addDomainSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { domain } = body.data;
    const alias = wwwAlias(domain);
    if (alias) return c.json({ error: alias }, 400);

    if (accountDomains(username).length >= account.maxDomains) {
      return c.json({ error: `The account reached its limit of ${account.maxDomains} domains` }, 409);
    }
    if (domainConflict(domain)) return c.json({ error: "That domain conflicts with one already in use" }, 409);
    if (hooksDomain() === domain) return c.json({ error: "That domain is the server webhook domain" }, 409);

    // The domain itself is also a hostname, ready to be assigned to an environment.
    return startJob(c, "domain.create", `Add domain ${domain}`, [dbStep("Register in the panel", () => {
      const createdAt = Date.now();
      db.transaction((tx) => {
        tx.insert(domains).values({ fqdn: domain, username, createdAt }).run();
        tx.insert(hostnames).values({ fqdn: domain, username, domain, createdAt }).run();
      });
    })], `${username}: ${domain}`);
  });

  routes.post("/accounts/:username/domains/:zone/delete", (c) => {
    const username = c.req.param("username");
    const zone = c.req.param("zone");
    const domain = db.select().from(domains).where(and(eq(domains.fqdn, zone), eq(domains.username, username))).get();
    if (!domain) return c.json({ error: "Not found" }, 404);
    // The environments are not deleted along with it: they hold the account files.
    const used = accountVhosts(username).filter((row) => domainOf(row) === zone).map(({ name }) => name);
    if (used.length > 0) return c.json({ error: `First delete or move its environments: ${used.join(", ")}` }, 409);
    // Its names would keep being mapped in OLS until the next change.
    const extras = db.select().from(hostnames).where(eq(hostnames.domain, zone)).all().filter((row) => row.vhost !== null).map(({ fqdn }) => fqdn);
    if (extras.length > 0) return c.json({ error: `First remove from their environments: ${extras.join(", ")}` }, 409);

    const certificate = certificateRow(zone);
    const hasMail = mailDomainsIn(db, [zone]).length > 0;
    return startJob(c, "domain.delete", `Delete domain ${zone}`, [{
      name: hasMail ? "Delete the domain, its subdomains, its mail and its certificate" : "Delete the domain, its subdomains and its certificate",
      run: async () => {
        if (hasMail) await agent.call("mail.domain.remove", { domain: zone });
        if (certificate) await agent.call("cert.remove", { zone });
        db.delete(domains).where(eq(domains.fqdn, zone)).run();
        if (certificate) db.delete(certificates).where(eq(certificates.zone, zone)).run();
        if (hasMail) await syncSites();
      },
    }], `${username}: ${zone}`);
  });

  routes.post("/accounts/:username/hostnames", async (c) => {
    const username = c.req.param("username");
    if (!accountRow(username)) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, addHostnameSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { fqdn } = body.data;
    const alias = wwwAlias(fqdn);
    if (alias) return c.json({ error: alias }, 400);

    const domain = accountDomains(username).find((row) => fqdn.endsWith(`.${row.fqdn}`));
    if (!domain) return c.json({ error: "Add its domain to the account first" }, 400);
    if (hostnameRow(fqdn)) return c.json({ error: "That subdomain already exists" }, 409);
    if (hooksDomain() === fqdn) return c.json({ error: "That domain is the server webhook domain" }, 409);
    const reserved = mailReservedConflict(db, fqdn);
    if (reserved) return c.json({ error: reserved }, 409);

    return startJob(c, "hostname.create", `Add subdomain ${fqdn}`, [dbStep("Register in the panel", () => {
      db.insert(hostnames).values({ fqdn, username, domain: domain.fqdn, createdAt: Date.now() }).run();
    })], `${username}: ${fqdn}`);
  });

  routes.post("/hostnames/:fqdn/delete", (c) => {
    const row = hostnameRow(c.req.param("fqdn"));
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.fqdn === row.domain) return c.json({ error: "It is the domain itself: delete the domain instead" }, 400);
    const user = vhostByHostname(row.fqdn) ?? (row.vhost !== null ? vhostRow(row.vhost) : undefined);
    if (user) return c.json({ error: `It is assigned to ${user.name}: unassign it first` }, 409);
    return startJob(c, "hostname.delete", `Delete subdomain ${row.fqdn}`, [dbStep("Delete from the panel", () => {
      db.delete(hostnames).where(eq(hostnames.fqdn, row.fqdn)).run();
    })], `${row.username}: ${row.fqdn}`);
  });

  /** Free for this account: it is its own and no environment uses it. */
  function freeHostname(username: string, fqdn: string): { domain: string } | { error: string; status: 400 | 409 } {
    const host = hostnameRow(fqdn);
    if (!host || host.username !== username) return { error: "That domain does not belong to the account", status: 400 };
    const user = vhostByHostname(fqdn) ?? (host.vhost !== null ? vhostRow(host.vhost) : undefined);
    if (user) return { error: `It is already assigned to ${user.name}`, status: 409 };
    return { domain: host.domain };
  }

  routes.post("/accounts/:username/vhosts", async (c) => {
    const username = c.req.param("username");
    const account = accountRow(username);
    if (!account) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, createVhostSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { name, hostname, phpVersion } = body.data;
    const slug = vhostSlugSchema.safeParse(body.data.slug ?? slugify(name));
    if (!slug.success) return c.json({ error: "Choose a slug: letters and digits only" }, 400);

    const free = freeHostname(username, hostname);
    if ("error" in free) return c.json({ error: free.error }, free.status);
    if (vhostCount(username) >= account.maxVhosts) {
      return c.json({ error: `The account reached its limit of ${account.maxVhosts} environments` }, 409);
    }
    if (vhostBySlug(slug.data)) return c.json({ error: `The slug ${slug.data} is already in use on this server` }, 409);
    if (!(await assertPhpAvailable(phpVersion))) return c.json({ error: "That PHP version is not available" }, 400);

    const row = newVhost({ username, slug: slug.data, name, hostname, phpVersion, createdAt: Date.now() });
    return startJob(c, "vhost.create", `Create environment ${name}`, vhostSteps(
      row,
      () => db.insert(vhosts).values(row).run(),
      () => db.delete(vhosts).where(eq(vhosts.slug, row.slug)).run(),
    ), `${username}: ${row.slug} (${hostname})`);
  });

  /** Another domain or subdomain of the account, free. Its directory, FTP and data stay as they are. */
  routes.post("/vhosts/:vhost/hostname", async (c) => {
    const row = vhostOf(c);
    if (!row) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, setHostnameSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { hostname } = body.data;
    if (hostname === row.hostname) return c.json({ error: "No changes" }, 409);
    const free = freeHostname(row.username, hostname);
    if ("error" in free) return c.json({ error: free.error }, free.status);
    // An alias has to be of the domain of its environment: its certificate is the only one the vhost has.
    const strayAliases = extrasOf(row.id).filter(({ mode, domain }) => mode === "alias" && domain !== free.domain).map(({ fqdn }) => fqdn);
    if (strayAliases.length > 0) return c.json({ error: `These aliases are not of ${free.domain}: remove them first: ${strayAliases.join(", ")}` }, 409);

    const apply = async (value: string) => {
      db.update(vhosts).set({ hostname: value }).where(eq(vhosts.id, row.id)).run();
      await writeSite({ ...row, hostname: value });
      await syncSites({ restart: true });
    };
    return startJob(c, "vhost.hostname", `Change the domain of ${row.name}`, [{
      name: "Update the environment and restart OLS",
      run: () => apply(hostname),
      compensate: () => apply(row.hostname),
    }], `${row.slug}: ${row.hostname} a ${hostname}`);
  });

  /**
   * Another name of the account for this environment. An alias serves it as is: only of its own domain and, if it has
   * a certificate, one it covers, because the vhost has a single certificate. A redirect sends a 301 to its hostname
   * from any domain of the account, through a vhost of that domain without PHP.
   */
  routes.post("/vhosts/:vhost/extras", async (c) => {
    const row = vhostOf(c);
    if (!row) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, addExtraSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { fqdn, mode } = body.data;
    const free = freeHostname(row.username, fqdn);
    if ("error" in free) return c.json({ error: free.error }, free.status);
    if (mode === "alias") {
      if (free.domain !== domainOf(row)) return c.json({ error: `An alias has to be of ${domainOf(row)}, like the environment. From another domain, use a redirect` }, 400);
      const certificate = certificateRow(free.domain);
      if (certificate && !certCovers(certificate.names, fqdn)) {
        return c.json({ error: `The certificate of ${free.domain} does not cover ${fqdn}: use a redirect, or a certificate that covers it` }, 400);
      }
    }

    const assign = async (vhost: number | null) => {
      db.update(hostnames).set({ vhost, mode: vhost === null ? null : mode }).where(eq(hostnames.fqdn, fqdn)).run();
      await syncSites({ restart: true });
    };
    return startJob(c, "vhost.extra", mode === "alias" ? `Add alias ${fqdn} to ${row.name}` : `Redirect ${fqdn} to ${row.name}`, [{
      name: "Apply to OpenLiteSpeed",
      run: () => assign(row.id),
      compensate: () => assign(null),
    }], `${row.slug}: ${mode} ${fqdn}`);
  });

  routes.post("/vhosts/:vhost/extras/:fqdn/delete", (c) => {
    const row = vhostOf(c);
    if (!row) return c.json({ error: "Not found" }, 404);
    const extra = extrasOf(row.id).find(({ fqdn }) => fqdn === c.req.param("fqdn"));
    if (!extra) return c.json({ error: "Not found" }, 404);

    const assign = async (vhost: number | null) => {
      db.update(hostnames).set({ vhost, mode: vhost === null ? null : extra.mode }).where(eq(hostnames.fqdn, extra.fqdn)).run();
      await syncSites({ restart: true });
    };
    return startJob(c, "vhost.extra.delete", `Remove ${extra.fqdn} from ${row.name}`, [{
      name: "Apply to OpenLiteSpeed",
      run: () => assign(null),
      compensate: () => assign(row.id),
    }], `${row.slug}: ${extra.fqdn}`);
  });

  /**
   * The name changes only in the panel. A new slug moves `~/sites/<slug>`, its OLS logs and its FTP login, and the
   * default directory follows it; a custom one is left alone.
   */
  routes.post("/vhosts/:vhost/name", async (c) => {
    const row = vhostOf(c);
    if (!row) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, renameVhostSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { name, slug } = body.data;
    if (name === row.name && slug === row.slug) return c.json({ error: "No changes" }, 409);
    if (slug !== row.slug && vhostBySlug(slug)) return c.json({ error: `The slug ${slug} is already in use on this server` }, 409);

    if (slug === row.slug) {
      return startJob(c, "vhost.name", `Rename ${row.name} to ${name}`, [{
        name: "Save the name",
        run: async () => {
          db.update(vhosts).set({ name }).where(eq(vhosts.id, row.id)).run();
        },
      }], `${row.slug}: ${name}`);
    }

    const prefix = (value: string) => `${siteDir(value)}/`;
    const docRootFor = (from: string, to: string, docRoot: string) => (docRoot.startsWith(prefix(from)) ? `${prefix(to)}${docRoot.slice(prefix(from).length)}` : docRoot);
    const move = async (from: string, to: string, nextName: string) => {
      await agent.call("site.rename", { username: row.username, from, to });
      const current = vhostRow(row.id) ?? row;
      const docRoot = docRootFor(from, to, current.docRoot);
      db.update(vhosts).set({ slug: to, name: nextName, docRoot }).where(eq(vhosts.id, row.id)).run();
      await writeSite({ ...current, slug: to, name: nextName, docRoot });
      await syncSites({ restart: true });
      // The PHP socket has the slug in its name: the processes of the old one would keep running.
      await agent.call("php.restart", { username: row.username });
    };
    return startJob(c, "vhost.slug", `Rename ${row.name} to ${name}`, [{
      name: `Move ${row.slug} to ${slug} and restart OLS`,
      run: () => move(row.slug, slug, name),
      compensate: () => move(slug, row.slug, row.name),
    }], `${row.slug} a ${slug}`);
  });

  routes.post("/vhosts/:vhost/delete", (c) => {
    const row = vhostOf(c);
    if (!row) return c.json({ error: "Not found" }, 404);

    const app = appRow(row.id);
    return startJob(c, "vhost.delete", `Delete environment ${row.name}`, [
      {
        name: "Remove from OpenLiteSpeed",
        run: () => syncSites({ exclude: [row.id] }),
        compensate: () => syncSites(),
      },
      {
        name: "Delete the environment configuration",
        run: async () => {
          // The app data stays in the account home directory, like the files of a PHP environment.
          if (app) await agent.call("app.remove", { appId: app.id, username: row.username });
          await agent.call("ftp.removeSite", { username: row.username, site: row.slug });
          await agent.call("site.remove", { site: row.slug });
          // Its hostname is freed, and the account webhook domain cleared, by the foreign keys.
          db.delete(vhosts).where(eq(vhosts.id, row.id)).run();
        },
      },
    ], `${row.username}: ${row.slug}`);
  });

  routes.post("/vhosts/:vhost/php", async (c) => {
    const row = vhostOf(c);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.type === "app") return c.json({ error: "It is an app: it does not use PHP" }, 400);
    const body = await readBody(c, setPhpSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { phpVersion } = body.data;
    // Restarting OLS briefly interrupts every site: it is not done if nothing changes.
    if (phpVersion === row.phpVersion) return c.json({ error: "The environment already uses that PHP version" }, 409);
    if (!(await assertPhpAvailable(phpVersion))) return c.json({ error: "That PHP version is not available" }, 400);

    const previous = row.phpVersion;
    const setVersion = async (version: string) => {
      await writeSite({ ...row, phpVersion: version });
      await syncSites({ restart: true });
      await agent.call("php.restart", { username: row.username });
      db.update(vhosts).set({ phpVersion: version }).where(eq(vhosts.id, row.id)).run();
    };

    return startJob(c, "vhost.php", `Change PHP of ${row.name}`, [{
      name: "Update the environment and restart OLS",
      run: () => setVersion(phpVersion),
      compensate: () => setVersion(previous),
    }], `${row.slug}: ${previous} a ${phpVersion}`);
  });

  routes.post("/accounts/:username/suspend", async (c) => {
    const username = c.req.param("username");
    const account = accountRow(username);
    if (!account) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, suspendSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { suspended } = body.data;
    if (suspended === account.suspended) return c.json({ error: suspended ? "The account is already suspended" : "The account is not suspended" }, 409);

    const setWeb = async (value: boolean) => {
      db.update(accounts).set({ suspended: value }).where(eq(accounts.username, username)).run();
      for (const row of accountVhosts(username)) await writeSite(row);
      await syncSites({ restart: true });
      // Without this, the PHP processes would stay alive. When reactivated, they start on their own with the first request.
      await agent.call("php.restart", { username });
      // Online apps are stopped; when reactivating, only those come back.
      for (const app of accountApps(username).filter(({ status, kind }) => status === "online" && kind === "server")) {
        await agent.call("app.control", { appId: app.id, action: value ? "stop" : "start" });
      }
    };
    const setServices = async (stop: boolean) => {
      const current = accountRow(username);
      if (!current) return;
      // The preference stays in the database: reactivating brings back what was active, and nothing else.
      if (current.redisEnabled) await agent.call("service.set", { username, service: "redis", enabled: !stop, memoryMb: current.redisMemoryMb });
      if (current.memcachedEnabled) await agent.call("service.set", { username, service: "memcached", enabled: !stop, memoryMb: current.memcachedMemoryMb });
    };
    const setFtp = async (value: boolean) => {
      await agent.call("ftp.setSuspended", { username, suspended: value });
    };
    const setDatabases = async (value: boolean) => {
      await agent.call("db.setLocked", { databases: accountDatabases(username).map(({ name }) => name), locked: value });
    };

    // When suspending, what is visible is cut first. When reactivating it is reversed: the site comes back with everything ready.
    const steps: { name: string; reactivate: string; apply: (value: boolean) => Promise<void> }[] = [
      { name: "Show the 503 page", reactivate: "Republish the sites", apply: setWeb },
      { name: "Stop Redis and Memcached", reactivate: "Start Redis and Memcached", apply: setServices },
      { name: "Block FTP", reactivate: "Restore FTP", apply: setFtp },
      { name: "Block MySQL", reactivate: "Restore MySQL", apply: setDatabases },
    ];
    const ordered = suspended ? steps : [...steps].reverse();
    return startJob(c, "account.suspend", suspended ? `Suspend ${username}` : `Reactivate ${username}`, ordered.map(({ name, reactivate, apply }) => ({
      name: suspended ? name : reactivate,
      run: () => apply(suspended),
      compensate: () => apply(!suspended),
    })), username);
  });

  routes.post("/accounts/:username/php/restart", (c) => {
    const username = c.req.param("username");
    if (!accountRow(username)) return c.json({ error: "Not found" }, 404);
    return startJob(c, "php.restart", `Restart PHP of ${username}`, [{
      name: "Restart the PHP processes",
      run: async () => {
        await agent.call("php.restart", { username });
      },
    }], username);
  });

  routes.get("/vhosts/:vhost/logs", async (c) => {
    const row = vhostOf(c);
    if (!row) return c.json({ error: "Not found" }, 404);
    const query = logQuerySchema.safeParse({ source: c.req.query("source"), lines: c.req.query("lines") ?? undefined });
    if (!query.success) return c.json({ error: "Invalid query" }, 400);
    try {
      return c.json(await agent.call("logs.read", { username: row.username, site: row.slug, source: query.data.source, lines: query.data.lines }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not read the log" }, 502);
    }
  });

  routes.post("/vhosts/:vhost/options", async (c) => {
    const row = vhostOf(c);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.type === "app") return c.json({ error: "It is an app: it does not use PHP" }, 400);
    const body = await readBody(c, vhostOptionsSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { docRoot, phpVersion, phpOptions, logLevel, logDays } = body.data;
    if (!isPublishableDocRoot(docRoot)) return c.json({ error: "That directory is private: it cannot be published" }, 400);
    if (!(await assertPhpAvailable(phpVersion))) return c.json({ error: "That PHP version is not available" }, 400);

    const apply = async (next: Pick<VhostRow, "docRoot" | "phpVersion" | "phpOptions" | "logLevel" | "logDays">) => {
      await writeSite({ ...row, ...next });
      await syncSites({ restart: true });
      // OLS does not restart lsphp: without this, changing the processes would have no effect. Measured on the VPS.
      await agent.call("php.restart", { username: row.username });
      db.update(vhosts).set(next).where(eq(vhosts.id, row.id)).run();
    };
    const previous = { docRoot: row.docRoot, phpVersion: row.phpVersion, phpOptions: row.phpOptions, logLevel: row.logLevel, logDays: row.logDays };

    return startJob(c, "vhost.options", `Save options of ${row.name}`, [{
      name: "Update the environment and restart OLS",
      run: () => apply({ docRoot, phpVersion, phpOptions, logLevel, logDays }),
      compensate: () => apply(previous),
    }], row.slug);
  });

  routes.get("/server-ip", async (c) => {
    try {
      return c.json(await agent.call("system.publicIp", {}));
    } catch {
      return c.json({ error: "The agent is not responding" }, 503);
    }
  });

  routes.post("/accounts/:username/ftp/password", (c) => {
    const username = c.req.param("username");
    if (!accountRow(username)) return c.json({ error: "Not found" }, 404);
    const password = generateSecret();
    return startJob(c, "ftp.password", `Regenerate FTP password of ${username}`, [{
      name: "Change the password",
      run: async () => {
        await agent.call("ftp.setPassword", { username, password });
        db.update(accounts).set({ ftpPasswordChangedAt: Date.now() }).where(eq(accounts.username, username)).run();
      },
    }], username, password);
  });

  routes.post("/vhosts/:vhost/ftp/password", (c) => {
    const row = vhostOf(c);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.type === "app") return c.json({ error: "It is an app: it has no files to upload over FTP" }, 409);
    const password = generateSecret();
    const creating = row.ftpPasswordChangedAt === null;
    return startJob(c, "vhost.ftpPassword", creating ? `Create FTP access for ${row.name}` : `Regenerate FTP password of ${row.name}`, [{
      name: creating ? "Create the FTP access" : "Change the password",
      run: async () => {
        // vsftpd rejects a login whose directory is missing: writing the environment creates it.
        await writeSite(row);
        await agent.call("ftp.setSitePassword", { username: row.username, site: row.slug, password });
        db.update(vhosts).set({ ftpPasswordChangedAt: Date.now() }).where(eq(vhosts.id, row.id)).run();
      },
    }], row.slug, password);
  });

  routes.post("/vhosts/:vhost/ftp/delete", (c) => {
    const row = vhostOf(c);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.ftpPasswordChangedAt === null) return c.json({ error: "The environment has no FTP access" }, 409);
    return startJob(c, "vhost.ftpDelete", `Remove FTP access of ${row.name}`, [{
      name: "Remove the FTP access",
      run: async () => {
        await agent.call("ftp.removeSite", { username: row.username, site: row.slug });
        db.update(vhosts).set({ ftpPasswordChangedAt: null }).where(eq(vhosts.id, row.id)).run();
      },
    }], row.slug);
  });

  routes.post("/accounts/:username/databases", async (c) => {
    const username = c.req.param("username");
    const account = accountRow(username);
    if (!account) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, createDatabaseSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { name } = body.data;
    const database = `${username}_${name}`;

    if (accountDatabases(username).length >= account.maxDatabases) {
      return c.json({ error: `The account reached its limit of ${account.maxDatabases} databases` }, 409);
    }
    if (account.suspended) return c.json({ error: "The account is suspended" }, 409);
    if (account.dbBlocked) return c.json({ error: "Writes on this account's databases are blocked" }, 409);
    if (db.select().from(databases).where(eq(databases.name, database)).get()) return c.json({ error: "That database already exists" }, 409);

    const password = generateSecret();
    return startJob(c, "database.create", `Create database ${database}`, [{
      name: "Create the database and its user",
      run: async () => {
        await agent.call("db.create", { username, name, password });
        db.insert(databases).values({ name: database, username, createdAt: Date.now() }).run();
      },
      compensate: async () => {
        await agent.call("db.delete", { username, name });
        db.delete(databases).where(eq(databases.name, database)).run();
      },
    }], database, password);
  });

  /** Looks up the database inside the account: it never operates on a foreign one or one the panel did not create. */
  function databaseOf(c: Context) {
    const username = c.req.param("username") ?? "";
    const database = c.req.param("database") ?? "";
    const row = db.select().from(databases).where(and(eq(databases.name, database), eq(databases.username, username))).get();
    return row ? { username, database, name: shortDbName(username, database) } : null;
  }

  routes.post("/accounts/:username/databases/:database/password", (c) => {
    const target = databaseOf(c);
    if (!target) return c.json({ error: "Not found" }, 404);
    const { username, database, name } = target;
    const password = generateSecret();
    return startJob(c, "database.password", `Regenerate password of ${database}`, [{
      name: "Change the password",
      run: async () => {
        await agent.call("db.setPassword", { username, name, password });
      },
    }], database, password);
  });

  routes.post("/accounts/:username/databases/:database/optimize", (c) => {
    const target = databaseOf(c);
    if (!target) return c.json({ error: "Not found" }, 404);
    const { username, database, name } = target;
    return startJob(c, "database.optimize", `Optimize ${database}`, [{
      name: "Rebuild the tables",
      run: async () => {
        await agent.call("db.optimize", { username, name });
      },
    }], database);
  });

  routes.post("/accounts/:username/databases/:database/delete", (c) => {
    const target = databaseOf(c);
    if (!target) return c.json({ error: "Not found" }, 404);
    const { username, database, name } = target;
    return startJob(c, "database.delete", `Delete database ${database}`, [{
      name: "Delete the database and its user",
      run: async () => {
        await agent.call("db.delete", { username, name });
        db.delete(databases).where(eq(databases.name, database)).run();
      },
    }], database);
  });

  routes.post("/accounts/:username/services/:service", async (c) => {
    const username = c.req.param("username");
    const account = accountRow(username);
    if (!account) return c.json({ error: "Not found" }, 404);
    const service = accountServiceSchema.safeParse(c.req.param("service"));
    if (!service.success) return c.json({ error: "Not found" }, 404);
    if (account.suspended) return c.json({ error: "The account is suspended" }, 409);
    const body = await readBody(c, setServiceSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { enabled, memoryMb } = body.data;
    const name = service.data;
    const previous = name === "redis"
      ? { enabled: account.redisEnabled, memoryMb: account.redisMemoryMb }
      : { enabled: account.memcachedEnabled, memoryMb: account.memcachedMemoryMb };

    const apply = async (next: { enabled: boolean; memoryMb: number }) => {
      await agent.call("service.set", { username, service: name, ...next });
      db.update(accounts).set(serviceColumns(name, next.enabled, next.memoryMb)).where(eq(accounts.username, username)).run();
    };

    return startJob(c, "service.set", enabled ? `Apply ${name} for ${username}` : `Disable ${name} for ${username}`, [{
      name: enabled ? "Apply the configuration and start" : "Stop the service",
      run: () => apply({ enabled, memoryMb }),
      compensate: () => apply(previous),
    }], `${username}: ${name} ${enabled ? "activo" : "inactivo"}, ${memoryMb} MB`);
  });

  routes.post("/accounts/:username/domains/:zone/origin-pull", async (c) => {
    const username = c.req.param("username");
    const zone = c.req.param("zone");
    const certificate = db.select().from(certificates).where(and(eq(certificates.zone, zone), eq(certificates.username, username))).get();
    if (!certificate) return c.json({ error: "That domain has no certificate in this account" }, 404);
    const body = await readBody(c, originPullSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { enabled } = body.data;
    if (enabled === certificate.originPull) return c.json({ error: enabled ? "It is already enabled" : "It is already disabled" }, 409);

    const apply = async (value: boolean) => {
      db.update(certificates).set({ originPull: value }).where(eq(certificates.zone, zone)).run();
      for (const row of accountVhosts(username).filter((vhost) => domainOf(vhost) === zone)) await writeSite(row);
      await syncSites({ restart: true });
    };

    return startJob(c, "certificate.originPull", enabled ? `Require the Cloudflare certificate on ${zone}` : `Stop requiring the Cloudflare certificate on ${zone}`, [{
      name: "Update the environments and restart OLS",
      run: () => apply(enabled),
      compensate: () => apply(!enabled),
    }], `${username}: ${zone} ${enabled ? "activo" : "inactivo"}`);
  });

  routes.post("/accounts/:username/domains/:zone/certificate", async (c) => {
    const username = c.req.param("username");
    const zone = c.req.param("zone");
    if (!accountRow(username)) return c.json({ error: "Not found" }, 404);
    if (!db.select().from(domains).where(and(eq(domains.fqdn, zone), eq(domains.username, username))).get()) {
      return c.json({ error: "That domain does not belong to the account" }, 404);
    }
    const body = await readBody(c, certificateSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);

    const previous: CertificateRow | undefined = certificateRow(zone);
    let issued: { names: string[]; notAfter: number } | null = null;

    const applyToSites = async () => {
      for (const row of accountVhosts(username).filter((vhost) => domainOf(vhost) === zone)) await writeSite(row);
      await syncSites({ restart: true });
    };

    // The key lives only in this closure until it reaches the agent: it is stored neither in the database nor in the job.
    const { certPem, keyPem } = body.data;
    return startJob(c, "certificate.set", `Install certificate for ${zone}`, [
      {
        name: "Validate and save the certificate",
        run: async () => {
          issued = await agent.call("cert.write", { zone, certPem, keyPem });
        },
        compensate: async () => {
          // If it was replacing another one, that was already overwritten: the new one is valid and the vhost should not be left without a file.
          if (!previous) await agent.call("cert.remove", { zone });
        },
      },
      {
        name: "Apply to the covered environments",
        run: async () => {
          if (!issued) throw new Error("The certificate was not validated");
          const values = { zone, username, names: issued.names, notAfter: issued.notAfter };
          db.insert(certificates).values(values).onConflictDoUpdate({ target: certificates.zone, set: values }).run();
          await applyToSites();
        },
        compensate: async () => {
          db.delete(certificates).where(eq(certificates.zone, zone)).run();
          if (previous) db.insert(certificates).values(previous).run();
          await applyToSites();
        },
      },
    ], `${username}: ${zone}`);
  });

  const { requestDeploy, resumeDeploys } = registerAppRoutes(routes, { db, agent, jobs, readBody, startJob, accountRow, vhostRow, appRow, accountApps, writeSite, syncSites });

  // -------------------------------------------------------------------------- Webhooks

  /**
   * GitHub calls Cloudflare over HTTPS, but the environment needs no certificate: with Flexible SSL Cloudflare connects
   * over HTTP and OLS also publishes the path on port 80.
   */
  const hookVhostSchema = z.object({ vhost: z.number().int().positive().nullable() }).strict();

  routes.post("/accounts/:username/hook-vhost", async (c) => {
    const account = accountRow(c.req.param("username"));
    if (!account) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, hookVhostSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const next = body.data.vhost;
    const target = next ? vhostRow(next) : null;
    if (next && (!target || target.username !== account.username)) return c.json({ error: "That environment does not belong to the account" }, 400);
    const previous = account.hookVhost;
    if (previous === next) return c.json({ error: "No changes" }, 409);
    const rewrite = async () => {
      for (const id of [previous, next]) {
        const row = id ? vhostRow(id) : undefined;
        if (row) await writeSite(row);
      }
      await syncSites({ restart: true });
    };
    return startJob(c, "account.hookVhost", target ? `Publish webhooks on ${target.hostname}` : `Remove the webhook domain of ${account.username}`, [{
      name: "Publish the webhook path to OLS",
      run: async () => {
        db.update(accounts).set({ hookVhost: next }).where(eq(accounts.username, account.username)).run();
        await rewrite();
      },
      compensate: async () => {
        db.update(accounts).set({ hookVhost: previous }).where(eq(accounts.username, account.username)).run();
        await rewrite();
      },
    }], `${account.username}: ${target?.slug ?? "ninguno"}`);
  });

  routes.get("/settings/server", (c) => c.json({ hooksDomain: hooksDomain() } satisfies ServerSettingsDto));

  routes.get("/settings/mysql", async (c) => {
    const state = await agent.call("mysql.diagnostics.get", {}).catch(() => ({ running: null, configured: false, memoryMb: null }));
    return c.json(state satisfies MysqlSettingsDto);
  });

  // Restarts MySQL: every site is a few seconds without its database.
  routes.post("/settings/mysql", async (c) => {
    const body = await readBody(c, z.object({ performanceSchema: z.boolean() }).strict());
    if ("error" in body) return c.json({ error: body.error }, 400);
    const enabled = body.data.performanceSchema;
    return startJob(c, "mysql.diagnostics", `${enabled ? "Turn on" : "Turn off"} MySQL performance_schema`, [{
      name: "Restart MySQL with the new setting",
      run: async () => {
        await agent.call("mysql.diagnostics.set", { enabled });
      },
    }], enabled ? "on" : "off");
  });

  const serverSettingsSchema = z.object({ hooksDomain: fqdnSchema.nullable() }).strict();

  routes.post("/settings/server", async (c) => {
    const body = await readBody(c, serverSettingsSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const next = body.data.hooksDomain;
    const previous = hooksDomain();
    if (next === previous) return c.json({ error: "No changes" }, 409);
    // It cannot be the domain of a site: OLS maps each name to a single vhost.
    if (next && hostnameRow(next)) return c.json({ error: "That domain already belongs to an account" }, 409);
    const save = (value: string | null) => {
      if (value) db.insert(settings).values({ key: "hooks_domain", value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
      else db.delete(settings).where(eq(settings.key, "hooks_domain")).run();
    };
    return startJob(c, "settings.hooksDomain", next ? `Publish webhooks on ${next}` : "Remove the global webhook domain", [{
      name: "Publish the domain to OLS",
      run: async () => {
        save(next);
        await syncSites({ restart: true });
      },
      compensate: async () => {
        save(previous);
        await syncSites({ restart: true });
      },
    }], next ?? "ninguno");
  });

  const webhookDeps: WebhookDeps = {
    hooksDomain,
    // OLS sends the account path only to the environment chosen for it, by its hostname.
    accountForHookDomain: (fqdn) => {
      const vhost = vhostByHostname(fqdn);
      const account = vhost ? accountRow(vhost.username) : undefined;
      return account && vhost && account.hookVhost === vhost.id && !account.suspended ? account.username : null;
    },
    apps: () => db.select({ vhost: apps.vhost, username: vhosts.username, repoUrl: apps.repoUrl, branch: apps.branch, webhookSecret: apps.webhookSecret })
      .from(apps).innerJoin(vhosts, eq(vhosts.id, apps.vhost)).all(),
    deploy: requestDeploy,
  };

  const backups = createBackups({ db, agent, jobs, writeSite, syncSites });
  registerMigrationRoutes(routes, { db, agent, jobs, writeSite, syncSites, domainConflict, requestDeploy });
  backups.register(routes, startJob);
  const mail = registerMailRoutes(routes, { db, agent, readBody, startJob, lookup: dnsLookup, syncSites: () => syncSites() });

  /**
   * Once per start: if what the agent writes for every environment changed since the last time, it rewrites them all,
   * applies them to OLS and restarts PHP, so an upgraded server does not keep the old configuration until each one
   * is touched. Saved only when it finished: an interrupted run is repeated on the next start.
   */
  function applyServerConfig(): string | null {
    if (settingValue(SERVER_CONFIG_KEY) === SERVER_CONFIG_REVISION) return null;
    const save = () => {
      db.insert(settings).values({ key: SERVER_CONFIG_KEY, value: SERVER_CONFIG_REVISION }).onConflictDoUpdate({ target: settings.key, set: { value: SERVER_CONFIG_REVISION } }).run();
    };
    const rows = db.select().from(vhosts).all();
    if (rows.length === 0) {
      save();
      return null;
    }
    return jobs.enqueue({
      type: "server.config",
      title: "Apply the panel configuration to every environment",
      steps: [
        { name: "Rewrite the environments", run: async () => { for (const row of db.select().from(vhosts).all()) await writeSite(row); } },
        { name: "Apply to OpenLiteSpeed", run: () => syncSites({ restart: true }) },
        {
          name: "Restart PHP",
          // Its processes outlive the OLS restart: they would keep the previous .ini files.
          run: async () => { for (const username of new Set(db.select().from(vhosts).all().map((row) => row.username))) await agent.call("php.restart", { username }); },
        },
        { name: "Save", run: async () => save() },
      ],
    }).id;
  }

  return { routes, webhookDeps, resumeDeploys, applyServerConfig, backups, mail, accountExists: (username: string) => accountRow(username) !== undefined };

}
