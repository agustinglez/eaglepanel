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
  docRootSchema,
  fqdnSchema,
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
  usernameSchema,
  type AccountDto,
  type AccountLimits,
  type AccountService,
  type AppDto,
  type JobCreatedDto,
  type ServerSettingsDto,
  type VhostDto,
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
import { accounts, appEnv, apps, certificates, databases, deployQueue, domains, settings, vhosts } from "./db/schema";
import type { JobRunner, JobStep } from "./jobs";
import type { WebhookDeps } from "./webhooks";

type VhostRow = typeof vhosts.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;
type CertificateRow = typeof certificates.$inferSelect;

const createAccountSchema = z.object({
  username: usernameSchema,
  domain: fqdnSchema,
  phpVersion: phpVersionSchema,
  limits: accountLimitsSchema.default(DEFAULT_LIMITS),
}).strict();
const addDomainSchema = z.object({ domain: fqdnSchema, phpVersion: phpVersionSchema }).strict();
const createVhostSchema = z.object({ fqdn: fqdnSchema, domain: fqdnSchema, phpVersion: phpVersionSchema }).strict();
const setPhpSchema = z.object({ phpVersion: phpVersionSchema }).strict();
const deleteAccountSchema = z.object({ confirm: z.string() }).strict();
const certificateSchema = z.object({ certPem: pemSchema, keyPem: pemSchema }).strict();
const createDatabaseSchema = z.object({ name: dbNameSchema }).strict();
const setServiceSchema = z.object({ enabled: z.boolean(), memoryMb: serviceMemorySchema }).strict();
const originPullSchema = z.object({ enabled: z.boolean() }).strict();
const suspendSchema = z.object({ suspended: z.boolean() }).strict();
const vhostOptionsSchema = z.object({ docRoot: docRootSchema, phpVersion: phpVersionSchema, phpOptions: phpOptionsSchema, logLevel: logLevelSchema, logDays: logDaysSchema }).strict();
const logQuerySchema = z.object({ source: logSourceSchema, lines: z.coerce.number().pipe(logLinesSchema).default(200) });

/** Letters, digits, `-` and `_` only: it can be pasted into any client and needs no escaping. */
const generateSecret = () => randomBytes(24).toString("base64url");

/** The account's first domain uses `public_html`; any other environment, its own directory. */
const defaultDocRoot = (fqdn: string, first: boolean) => (first ? "public_html" : `subdomains/${fqdn}/public_html`);

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
}

async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<{ data: z.infer<S> } | { error: string }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? { data: parsed.data } : { error: parsed.error.issues[0]?.message ?? "Invalid data" };
}

export function createHostingRoutes({ db, agent, jobs }: HostingDeps) {
  const routes = new Hono();

  const accountRow = (username: string) => db.select().from(accounts).where(eq(accounts.username, username)).get();
  const vhostRow = (fqdn: string) => db.select().from(vhosts).where(eq(vhosts.fqdn, fqdn)).get();
  const accountDomains = (username: string) => db.select().from(domains).where(eq(domains.username, username)).orderBy(asc(domains.createdAt), asc(domains.fqdn)).all();
  const accountVhosts = (username: string) => db.select().from(vhosts).where(eq(vhosts.username, username)).all();
  const appRow = (fqdn: string) => db.select().from(apps).where(eq(apps.fqdn, fqdn)).get();
  const accountApps = (username: string) => accountVhosts(username).filter(({ type }) => type === "app").map(({ fqdn }) => appRow(fqdn)).filter((row) => row !== undefined);
  const settingValue = (key: string) => db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
  const hooksDomain = () => settingValue("hooks_domain");
  /** Any panel certificate that covers it: the server-wide domain belongs to no account. */
  const zoneCovering = (fqdn: string) => db.select().from(certificates).all().find((row) => certCovers(row.names, fqdn))?.zone ?? null;
  /** The URLs the account can enter in GitHub: the server-wide one and the one of its own webhook domain. */
  function hookUrls(username: string): string[] {
    const global = hooksDomain();
    const own = accountRow(username)?.hookDomain;
    return [...(global ? [`https://${global}${GLOBAL_HOOK_PATH}`] : []), ...(own ? [`https://${own}${ACCOUNT_HOOK_PATH}`] : [])];
  }

  function toAppDto(fqdn: string): AppDto | null {
    const row = appRow(fqdn);
    if (!row) return null;
    const { kind, repoUrl, branch, subdir, runtime, runtimeVersion, buildCommand, startCommand, outputDir, spaFallback, healthPath, memoryMb } = row;
    return {
      config: { kind, repoUrl, branch, subdir, runtime, runtimeVersion, buildCommand, startCommand, outputDir, spaFallback, healthPath, memoryMb },
      status: row.status,
      currentRelease: row.currentRelease,
      commit: row.commit,
      deployKey: row.deployKey,
      webhook: { secret: row.webhookSecret, urls: hookUrls(vhostRow(fqdn)?.username ?? "") },
      queue: db.select({ id: deployQueue.id, trigger: deployQueue.trigger, commit: deployQueue.commit, requestedAt: deployQueue.requestedAt })
        .from(deployQueue).where(eq(deployQueue.fqdn, fqdn)).orderBy(asc(deployQueue.id)).all(),
      env: db.select().from(appEnv).where(eq(appEnv.fqdn, fqdn)).orderBy(asc(appEnv.key)).all().map(({ key, value, scope }) => ({ key, value, scope })),
    };
  }
  const accountCerts = (username: string) => db.select().from(certificates).where(eq(certificates.username, username)).all();
  const certificateRow = (zone: string) => db.select().from(certificates).where(eq(certificates.zone, zone)).get();
  const extraVhosts = (username: string) => accountVhosts(username).filter((row) => !row.isMain).length;

  /** A domain cannot be equal to, the parent of, or a child of another: it would allow publishing under another account's name. */
  function domainConflict(fqdn: string): boolean {
    return db.select({ fqdn: domains.fqdn }).from(domains).all()
      .some((row) => row.fqdn === fqdn || fqdn.endsWith(`.${row.fqdn}`) || row.fqdn.endsWith(`.${fqdn}`));
  }

  function certZoneFor({ fqdn, domain }: Pick<VhostRow, "fqdn" | "domain">): string | null {
    const certificate = certificateRow(domain);
    return certificate && certCovers(certificate.names, fqdn) ? certificate.zone : null;
  }

  /** Without a certificate covering it, the environment is not on 443: there is no connection on which to require it. */
  function originPullFor(row: Pick<VhostRow, "fqdn" | "domain">): boolean {
    return certZoneFor(row) !== null && (certificateRow(row.domain)?.originPull ?? false);
  }

  /** Always reads the database: `ols.sync` receives the full list, so undoing means syncing again. */
  async function syncSites(options: { exclude?: string[]; restart?: boolean } = {}) {
    const excluded = new Set(options.exclude ?? []);
    const sites = db.select().from(vhosts).all()
      .filter(({ fqdn }) => !excluded.has(fqdn))
      .map((row) => ({ fqdn: row.fqdn, username: row.username, certZone: certZoneFor(row), originPull: originPullFor(row) }));
    const domain = hooksDomain();
    await agent.call("ols.sync", { sites, restart: options.restart, hooks: domain ? { fqdn: domain, certZone: zoneCovering(domain) } : null });
  }

  async function writeSite(row: VhostRow) {
    const { username, fqdn, docRoot, phpVersion, phpOptions, logLevel, logDays } = row;
    // Read here: any change to an environment of a suspended account must keep showing the 503.
    const suspended = accountRow(username)?.suspended ?? false;
    const appRecord = row.type === "app" ? appRow(fqdn) : undefined;
    const app = !appRecord ? null
      : appRecord.kind === "static"
        ? { kind: "static" as const, id: appRecord.id, release: appRecord.currentRelease, spaFallback: appRecord.spaFallback }
        : { kind: "server" as const, id: appRecord.id };
    const hooks = !suspended && accountRow(username)?.hookDomain === fqdn;
    await agent.call("site.write", { username, fqdn, docRoot, phpVersion, phpOptions, certZone: certZoneFor(row), originPull: originPullFor(row), logLevel, logDays, suspended, app, hooks });
  }

  function toVhostDto(row: VhostRow): VhostDto {
    const { fqdn, domain, isMain, type, docRoot, phpVersion, phpOptions, logLevel, logDays } = row;
    return { fqdn, domain, isMain, type, docRoot, phpVersion, phpOptions, logLevel, logDays, certZone: certZoneFor(row), app: type === "app" ? toAppDto(fqdn) : null };
  }

  const accountDatabases = (username: string) => db.select().from(databases).where(eq(databases.username, username)).orderBy(asc(databases.name)).all();
  const serviceColumns = (service: AccountService, enabled: boolean, memoryMb: number) =>
    service === "redis" ? { redisEnabled: enabled, redisMemoryMb: memoryMb } : { memcachedEnabled: enabled, memcachedMemoryMb: memoryMb };
  /** The chosen part of the name: `shop` in `acme_shop`. */
  const shortDbName = (username: string, database: string) => database.slice(username.length + 1);

  function toAccountDto(row: AccountRow): AccountDto {
    return {
      username: row.username,
      limits: limitsOf(row),
      suspended: row.suspended,
      createdAt: row.createdAt,
      domains: accountDomains(row.username).map(({ fqdn }) => fqdn),
      vhosts: accountVhosts(row.username)
        .map(toVhostDto)
        // Per domain, with its primary environment first.
        .sort((a, b) => a.domain.localeCompare(b.domain) || Number(b.isMain) - Number(a.isMain) || a.fqdn.localeCompare(b.fqdn)),
      certificates: accountCerts(row.username).map(({ zone, names, notAfter, originPull }) => ({ zone, names, notAfter, originPull })),
      databases: accountDatabases(row.username).map(({ name, sizeBytes }) => ({ name, sizeBytes })),
      dbBlocked: row.dbBlocked,
      ftpPasswordChangedAt: row.ftpPasswordChangedAt,
      services: {
        redis: { enabled: row.redisEnabled, memoryMb: row.redisMemoryMb, socket: serviceSocket("redis", row.username) },
        memcached: { enabled: row.memcachedEnabled, memoryMb: row.memcachedMemoryMb, socket: serviceSocket("memcached", row.username) },
      },
      hookDomain: row.hookDomain,
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
  function vhostSteps(row: VhostRow, register: () => void, unregister: () => void): JobStep[] {
    return [
      {
        name: "Register in the panel",
        run: async () => register(),
        compensate: async () => unregister(),
      },
      {
        name: `Create ${row.fqdn} and its directory`,
        run: () => writeSite(row),
        compensate: async () => {
          await agent.call("site.remove", { fqdn: row.fqdn });
        },
      },
      {
        name: "Apply to OpenLiteSpeed",
        run: () => syncSites(),
        compensate: () => syncSites({ exclude: [row.fqdn] }),
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
    const { username, domain, phpVersion, limits } = body.data;

    if (accountRow(username)) return c.json({ error: "An account with that username already exists" }, 409);
    if (domainConflict(domain)) return c.json({ error: "That domain conflicts with one already in use" }, 409);

    // Without nosymfollow and quotas, the account would be created without the isolation the panel promises.
    const preflight = await agent.call("system.preflight", {});
    if (!preflight.ok) {
      const failed = preflight.checks.filter((check) => !check.ok).map((check) => check.name).join(", ");
      return c.json({ error: `The server is not ready: ${failed}` }, 409);
    }
    if (!(await assertPhpAvailable(phpVersion))) return c.json({ error: "That PHP version is not available" }, 400);

    const createdAt = Date.now();
    const main: VhostRow = { fqdn: domain, username, domain, isMain: true, type: "php", docRoot: defaultDocRoot(domain, true), phpVersion, phpOptions: DEFAULT_PHP_OPTIONS, logLevel: DEFAULT_LOG_LEVEL, logDays: DEFAULT_LOG_DAYS, createdAt };
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
      ...vhostSteps(
        main,
        () => db.transaction((tx) => {
          tx.insert(accounts).values({ username, ...limitColumns(limits), createdAt }).run();
          tx.insert(domains).values({ fqdn: domain, username, createdAt }).run();
          tx.insert(vhosts).values(main).run();
        }),
        () => db.delete(accounts).where(eq(accounts.username, username)).run(),
      ),
      {
        // Undone by the first step: deleting the account also removes its FTP access.
        name: "Create the FTP account",
        run: async () => {
          await agent.call("ftp.setPassword", { username, password: ftpPassword });
          db.update(accounts).set({ ftpPasswordChangedAt: Date.now() }).where(eq(accounts.username, username)).run();
        },
      },
    ], `${username} (${domain})`, ftpPassword);
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
    const vhostsUsed = extraVhosts(username);
    if (limits.vhosts < vhostsUsed) return c.json({ error: `The account already uses ${vhostsUsed} additional environments` }, 409);

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
    const fqdns = rows.map(({ fqdn }) => fqdn);
    const zones = accountCerts(username).map(({ zone }) => zone);
    const dbNames = accountDatabases(username).map(({ name }) => shortDbName(username, name));
    const appsToRemove = accountApps(username);

    return startJob(c, "account.delete", `Delete account ${username}`, [
      {
        name: "Remove the environments from OpenLiteSpeed",
        run: () => syncSites({ exclude: fqdns }),
        compensate: () => syncSites(),
      },
      {
        name: "Delete the environments' configuration",
        run: async () => {
          for (const fqdn of fqdns) await agent.call("site.remove", { fqdn });
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
          for (const app of appsToRemove) await agent.call("app.remove", { appId: app.id, username, fqdn: app.fqdn });
          await agent.call("account.delete", { username });
          for (const zone of zones) await agent.call("cert.remove", { zone });
          await backups.dropExportsOf(username);
          db.delete(accounts).where(eq(accounts.username, username)).run();
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
    const { domain, phpVersion } = body.data;

    if (accountDomains(username).length >= account.maxDomains) {
      return c.json({ error: `The account reached its limit of ${account.maxDomains} domains` }, 409);
    }
    if (domainConflict(domain)) return c.json({ error: "That domain conflicts with one already in use" }, 409);
    if (!(await assertPhpAvailable(phpVersion))) return c.json({ error: "That PHP version is not available" }, 400);

    const createdAt = Date.now();
    const main: VhostRow = { fqdn: domain, username, domain, isMain: true, type: "php", docRoot: defaultDocRoot(domain, false), phpVersion, phpOptions: DEFAULT_PHP_OPTIONS, logLevel: DEFAULT_LOG_LEVEL, logDays: DEFAULT_LOG_DAYS, createdAt };
    return startJob(c, "domain.create", `Add domain ${domain}`, vhostSteps(
      main,
      () => db.transaction((tx) => {
        tx.insert(domains).values({ fqdn: domain, username, createdAt }).run();
        tx.insert(vhosts).values(main).run();
      }),
      () => db.delete(domains).where(eq(domains.fqdn, domain)).run(),
    ), `${username}: ${domain}`);
  });

  routes.post("/accounts/:username/vhosts", async (c) => {
    const username = c.req.param("username");
    const account = accountRow(username);
    if (!account) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, createVhostSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { fqdn, domain, phpVersion } = body.data;

    if (!accountDomains(username).some((row) => row.fqdn === domain)) return c.json({ error: "That domain does not belong to the account" }, 400);
    if (!fqdn.endsWith(`.${domain}`)) return c.json({ error: `Must be a subdomain of ${domain}` }, 400);
    if (extraVhosts(username) >= account.maxVhosts) {
      return c.json({ error: `The account reached its limit of ${account.maxVhosts} additional environments` }, 409);
    }
    if (vhostRow(fqdn)) return c.json({ error: "That environment already exists" }, 409);
    if (!(await assertPhpAvailable(phpVersion))) return c.json({ error: "That PHP version is not available" }, 400);

    const row: VhostRow = { fqdn, username, domain, isMain: false, type: "php", docRoot: defaultDocRoot(fqdn, false), phpVersion, phpOptions: DEFAULT_PHP_OPTIONS, logLevel: DEFAULT_LOG_LEVEL, logDays: DEFAULT_LOG_DAYS, createdAt: Date.now() };
    return startJob(c, "vhost.create", `Create environment ${fqdn}`, vhostSteps(
      row,
      () => db.insert(vhosts).values(row).run(),
      () => db.delete(vhosts).where(eq(vhosts.fqdn, fqdn)).run(),
    ), `${username}: ${fqdn}`);
  });

  routes.post("/vhosts/:fqdn/delete", (c) => {
    const row = vhostRow(c.req.param("fqdn"));
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.isMain) return c.json({ error: "The primary environment cannot be deleted" }, 400);

    const app = appRow(row.fqdn);
    return startJob(c, "vhost.delete", `Delete environment ${row.fqdn}`, [
      {
        name: "Remove from OpenLiteSpeed",
        run: () => syncSites({ exclude: [row.fqdn] }),
        compensate: () => syncSites(),
      },
      {
        name: "Delete the environment configuration",
        run: async () => {
          // The app data stays in the account home directory, like the files of a PHP environment.
          if (app) await agent.call("app.remove", { appId: app.id, username: row.username, fqdn: row.fqdn });
          await agent.call("site.remove", { fqdn: row.fqdn });
          db.transaction((tx) => {
            tx.update(accounts).set({ hookDomain: null }).where(and(eq(accounts.username, row.username), eq(accounts.hookDomain, row.fqdn))).run();
            tx.delete(vhosts).where(eq(vhosts.fqdn, row.fqdn)).run();
          });
        },
      },
    ], `${row.username}: ${row.fqdn}`);
  });

  routes.post("/vhosts/:fqdn/php", async (c) => {
    const row = vhostRow(c.req.param("fqdn"));
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
      db.update(vhosts).set({ phpVersion: version }).where(eq(vhosts.fqdn, row.fqdn)).run();
    };

    return startJob(c, "vhost.php", `Change PHP of ${row.fqdn}`, [{
      name: "Update the environment and restart OLS",
      run: () => setVersion(phpVersion),
      compensate: () => setVersion(previous),
    }], `${row.fqdn}: ${previous} a ${phpVersion}`);
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

  routes.get("/vhosts/:fqdn/logs", async (c) => {
    const row = vhostRow(c.req.param("fqdn"));
    if (!row) return c.json({ error: "Not found" }, 404);
    const query = logQuerySchema.safeParse({ source: c.req.query("source"), lines: c.req.query("lines") ?? undefined });
    if (!query.success) return c.json({ error: "Invalid query" }, 400);
    try {
      return c.json(await agent.call("logs.read", { username: row.username, fqdn: row.fqdn, source: query.data.source, lines: query.data.lines }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not read the log" }, 502);
    }
  });

  routes.post("/vhosts/:fqdn/options", async (c) => {
    const row = vhostRow(c.req.param("fqdn"));
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
      db.update(vhosts).set(next).where(eq(vhosts.fqdn, row.fqdn)).run();
    };
    const previous = { docRoot: row.docRoot, phpVersion: row.phpVersion, phpOptions: row.phpOptions, logLevel: row.logLevel, logDays: row.logDays };

    return startJob(c, "vhost.options", `Save options of ${row.fqdn}`, [{
      name: "Update the environment and restart OLS",
      run: () => apply({ docRoot, phpVersion, phpOptions, logLevel, logDays }),
      compensate: () => apply(previous),
    }], row.fqdn);
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
      for (const row of accountVhosts(username).filter(({ domain }) => domain === zone)) await writeSite(row);
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
      for (const row of accountVhosts(username).filter(({ domain }) => domain === zone)) await writeSite(row);
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
  const hookDomainSchema = z.object({ fqdn: fqdnSchema.nullable() }).strict();

  routes.post("/accounts/:username/hook-domain", async (c) => {
    const account = accountRow(c.req.param("username"));
    if (!account) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, hookDomainSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const next = body.data.fqdn;
    const target = next ? vhostRow(next) : null;
    if (next && (!target || target.username !== account.username)) return c.json({ error: "That environment does not belong to the account" }, 400);
    const previous = account.hookDomain;
    if (previous === next) return c.json({ error: "No changes" }, 409);
    const rewrite = async () => {
      for (const fqdn of [previous, next]) {
        const row = fqdn ? vhostRow(fqdn) : undefined;
        if (row) await writeSite(row);
      }
      await syncSites({ restart: true });
    };
    return startJob(c, "account.hookDomain", next ? `Publish webhooks on ${next}` : `Remove the webhook domain of ${account.username}`, [{
      name: "Publish the webhook path to OLS",
      run: async () => {
        db.update(accounts).set({ hookDomain: next }).where(eq(accounts.username, account.username)).run();
        await rewrite();
      },
      compensate: async () => {
        db.update(accounts).set({ hookDomain: previous }).where(eq(accounts.username, account.username)).run();
        await rewrite();
      },
    }], `${account.username}: ${next ?? "ninguno"}`);
  });

  routes.get("/settings/server", (c) => c.json({ hooksDomain: hooksDomain() } satisfies ServerSettingsDto));

  const serverSettingsSchema = z.object({ hooksDomain: fqdnSchema.nullable() }).strict();

  routes.post("/settings/server", async (c) => {
    const body = await readBody(c, serverSettingsSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const next = body.data.hooksDomain;
    const previous = hooksDomain();
    if (next === previous) return c.json({ error: "No changes" }, 409);
    // It cannot be the domain of a site: OLS maps each name to a single vhost.
    if (next && db.select({ fqdn: vhosts.fqdn }).from(vhosts).all().some((row) => row.fqdn === next)) {
      return c.json({ error: "That domain is already an environment of an account" }, 409);
    }
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
    accountForHookDomain: (fqdn) => {
      const row = db.select({ username: accounts.username, suspended: accounts.suspended }).from(accounts).where(eq(accounts.hookDomain, fqdn)).get();
      return row && !row.suspended ? row.username : null;
    },
    apps: () => db.select({ fqdn: apps.fqdn, username: vhosts.username, repoUrl: apps.repoUrl, branch: apps.branch, webhookSecret: apps.webhookSecret })
      .from(apps).innerJoin(vhosts, eq(vhosts.fqdn, apps.fqdn)).all(),
    deploy: requestDeploy,
  };

  const backups = createBackups({ db, agent, jobs, writeSite, syncSites });
  registerMigrationRoutes(routes, { db, agent, jobs, writeSite, syncSites, domainConflict, requestDeploy });
  backups.register(routes, startJob);

  return { routes, webhookDeps, resumeDeploys, backups, accountExists: (username: string) => accountRow(username) !== undefined };

}
