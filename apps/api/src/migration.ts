import {
  DEFAULT_LOG_DAYS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PHP_OPTIONS,
  DEFAULT_SERVICE_MEMORY_MB,
  appConfigSchema,
  authHashOf,
  backupRunIdSchema,
  bucketPrefixSchema,
  bucketSchema,
  dbFullNameSchema,
  docRootSchema,
  envKeySchema,
  envScopeSchema,
  envValueSchema,
  fqdnSchema,
  ftpHashSchema,
  logDaysSchema,
  logLevelSchema,
  phpOptionsSchema,
  phpVersionSchema,
  s3EndpointSchema,
  usernameSchema,
  type BackupManifest,
  type BackupSnapshot,
  type JobCreatedDto,
  type MigrationAccountDto,
  type ResticRepo,
} from "@eaglepanel/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { AgentClient } from "./agent-client";
import { audit } from "./audit";
import type { Db } from "./db";
import { accounts, appEnv, apps, certificates, databases, domains, vhosts } from "./db/schema";
import type { JobRunner, JobStep } from "./jobs";

/**
 * Migration of an account from another EaglePanel server. Each server has its own backup repository; this one reads
 * the source repository (with its password, which is not stored) and recreates the account exactly as it was in the
 * chosen backup. The source account may be active or suspended. If anything of the account already exists here, nothing is touched.
 */

type VhostRow = typeof vhosts.$inferSelect;
type AppRow = typeof apps.$inferSelect;

const credential = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/, "Invalid credential");
export const sourceRepoSchema = z.object({
  endpoint: s3EndpointSchema,
  bucket: bucketSchema,
  prefix: bucketPrefixSchema,
  region: z.string().regex(/^[a-z0-9-]{2,32}$/, "Invalid region"),
  accessKeyId: credential,
  secretAccessKey: credential,
  password: z.string().min(16).max(256),
}).strict();
type SourceRepo = z.infer<typeof sourceRepoSchema>;

const importSchema = z.object({ source: sourceRepoSchema, username: usernameSchema, run: backupRunIdSchema }).strict();
const listSchema = z.object({ source: sourceRepoSchema }).strict();

// Manifest rows are validated before going back into a database: they come from another server.
const accountRowSchema = z.object({
  username: usernameSchema,
  quotaMb: z.number().int().min(50),
  maxDomains: z.number().int().min(1),
  maxVhosts: z.number().int().min(0),
  maxDatabases: z.number().int().min(0),
  dbStorageMb: z.number().int().min(1),
  appMemoryMb: z.number().int().min(0),
  redisEnabled: z.boolean().optional(),
  redisMemoryMb: z.number().int().optional(),
  memcachedEnabled: z.boolean().optional(),
  memcachedMemoryMb: z.number().int().optional(),
  hookDomain: fqdnSchema.nullable().optional(),
}).loose();
const domainRowSchema = z.object({ fqdn: fqdnSchema }).loose();
const vhostRowSchema = z.object({
  fqdn: fqdnSchema, domain: fqdnSchema, isMain: z.boolean(), type: z.enum(["php", "app"]), docRoot: docRootSchema,
  phpVersion: phpVersionSchema, phpOptions: phpOptionsSchema.catch(DEFAULT_PHP_OPTIONS), logLevel: logLevelSchema.catch(DEFAULT_LOG_LEVEL), logDays: logDaysSchema.catch(DEFAULT_LOG_DAYS),
}).loose();
const certRowSchema = z.object({ zone: fqdnSchema, originPull: z.boolean().optional() }).loose();
const appRowSchema = z.object({ fqdn: fqdnSchema, id: z.number().int(), webhookSecret: z.string().nullable().optional(), deployKey: z.string().nullable().optional() }).loose();
const envRowSchema = z.object({ fqdn: fqdnSchema, key: envKeySchema, value: envValueSchema, scope: envScopeSchema });
const CONFIG_KEYS = ["kind", "repoUrl", "branch", "subdir", "runtime", "runtimeVersion", "buildCommand", "startCommand", "outputDir", "spaFallback", "healthPath", "memoryMb"] as const;
const MAX_APP_ID = 16383;

const toRepo = (source: SourceRepo): ResticRepo => ({
  repository: `s3:${source.endpoint}/${source.bucket}/${source.prefix}`,
  password: source.password,
  accessKeyId: source.accessKeyId,
  secretAccessKey: source.secretAccessKey,
  region: source.region,
});

function rows<T>(manifest: BackupManifest, key: string, schema: z.ZodType<T>): T[] {
  const list = Array.isArray(manifest.panel[key]) ? (manifest.panel[key] as unknown[]) : [];
  return list.map((row) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) throw new Error(`The backup has invalid data in ${key}: ${parsed.error.issues[0]?.message ?? ""}`);
    return parsed.data;
  });
}

export interface MigrationDeps {
  db: Db;
  agent: AgentClient;
  jobs: JobRunner;
  writeSite: (row: VhostRow) => Promise<void>;
  syncSites: (options?: { exclude?: string[]; restart?: boolean }) => Promise<void>;
  domainConflict: (fqdn: string) => boolean;
  requestDeploy: (fqdn: string, trigger: string) => unknown;
}

export function registerMigrationRoutes(routes: Hono, { db, agent, jobs, writeSite, syncSites, domainConflict, requestDeploy }: MigrationDeps) {
  /** The accounts in the source repository, each with its latest complete backup. */
  routes.post("/migrations/accounts", async (c) => {
    const body = listSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid data" }, 400);
    let snapshots: BackupSnapshot[];
    try {
      ({ snapshots } = await agent.call("backup.snapshots", { repo: toRepo(body.data.source) }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not read the repository" }, 502);
    }
    const byAccount = new Map<string, MigrationAccountDto>();
    for (const item of snapshots) {
      const entry = byAccount.get(item.username) ?? { username: item.username, exists: false, runs: [] };
      let run = entry.runs.find((candidate) => candidate.run === item.run);
      if (!run) {
        run = { run: item.run, time: item.time, complete: false };
        entry.runs.push(run);
      }
      byAccount.set(item.username, entry);
    }
    for (const entry of byAccount.values()) {
      entry.exists = db.select().from(accounts).where(eq(accounts.username, entry.username)).get() !== undefined;
      for (const run of entry.runs) {
        const parts = snapshots.filter((item) => item.username === entry.username && item.run === run.run);
        run.complete = parts.some((item) => item.part === "manifest") && parts.some((item) => item.part === "files");
      }
      entry.runs.sort((a, b) => b.time - a.time);
    }
    return c.json([...byAccount.values()].sort((a, b) => a.username.localeCompare(b.username)) satisfies MigrationAccountDto[]);
  });

  routes.post("/migrations/import", async (c) => {
    const body = importSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid data" }, 400);
    const { source, username, run } = body.data;
    const repo = toRepo(source);

    // ---------------------------------------------------------------- Checks: if anything clashes, nothing is done.
    if (db.select().from(accounts).where(eq(accounts.username, username)).get()) return c.json({ error: `An account ${username} already exists on this server` }, 409);
    let manifest: BackupManifest;
    let parts: BackupSnapshot[];
    try {
      parts = (await agent.call("backup.snapshots", { repo, username })).snapshots.filter((item) => item.run === run);
      const manifestPart = parts.find((item) => item.part === "manifest");
      if (!manifestPart || !parts.some((item) => item.part === "files")) return c.json({ error: "That backup is incomplete: the manifest or the files are missing" }, 409);
      manifest = (await agent.call("backup.manifest", { repo, snapshot: manifestPart.id })).manifest;
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not read the repository" }, 502);
    }
    if (manifest.username !== username) return c.json({ error: "That backup belongs to another account" }, 409);

    let plan: ReturnType<typeof readPlan>;
    try {
      plan = readPlan(manifest);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The backup has invalid data" }, 409);
    }
    const linuxUser = await agent.call("migrate.userCheck", { username });
    if (linuxUser.exists && !linuxUser.managed) return c.json({ error: `A Linux user ${username} not managed by the panel already exists on this server: it is left untouched` }, 409);
    if (linuxUser.exists) return c.json({ error: `A panel Linux user ${username} exists without an account: review it before importing` }, 409);
    for (const domain of plan.domains) {
      if (domainConflict(domain.fqdn)) return c.json({ error: `The domain ${domain.fqdn} is already in use on this server` }, 409);
    }
    for (const cert of plan.certificates) {
      if (db.select().from(certificates).where(eq(certificates.zone, cert.zone)).get()) return c.json({ error: `A certificate for ${cert.zone} already exists on this server` }, 409);
    }
    const preflight = await agent.call("system.preflight", {});
    if (!preflight.ok) return c.json({ error: `The server is not ready: ${preflight.checks.filter((check) => !check.ok).map((check) => check.name).join(", ")}` }, 409);
    const available = (await agent.call("php.versions", {})).versions;
    const missingPhp = plan.vhosts.find((row) => row.type === "php" && !available.includes(row.phpVersion));
    if (missingPhp) return c.json({ error: `${missingPhp.fqdn} uses PHP ${missingPhp.phpVersion}, which is not installed here` }, 409);

    // ---------------------------------------------------------------- Recrear
    // App ids belong to each server: new ones are assigned.
    const used = new Set(db.select({ id: apps.id }).from(apps).all().map(({ id }) => id));
    const newIds = new Map<number, number>();
    for (const app of plan.apps) {
      let id = 1;
      while (used.has(id) && id <= MAX_APP_ID) id += 1;
      if (id > MAX_APP_ID) return c.json({ error: "No app addresses left on this server" }, 409);
      used.add(id);
      newIds.set(app.row.id, id);
    }
    const fqdns = plan.vhosts.map(({ fqdn }) => fqdn);
    const databaseParts = parts.filter((item) => item.part === "database");
    const filesPart = parts.find((item) => item.part === "files")!;
    const createdAt = Date.now();

    /** If anything fails, everything created is deleted: the account is not left halfway. It is the first step's compensation. */
    async function undo() {
      const attempt = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { console.error("[api] while undoing the migration:", error); } };
      for (const database of plan.databases) await attempt(() => agent.call("db.delete", { username, name: database.slice(username.length + 1) }));
      for (const [, id] of newIds) {
        const app = plan.apps.find((item) => newIds.get(item.row.id) === id)!;
        await attempt(() => agent.call("app.remove", { appId: id, username, fqdn: app.row.fqdn }));
      }
      await attempt(() => syncSites({ exclude: fqdns }));
      for (const fqdn of fqdns) await attempt(() => agent.call("site.remove", { fqdn }));
      for (const cert of plan.certificates) await attempt(() => agent.call("cert.remove", { zone: cert.zone }));
      await attempt(() => agent.call("account.delete", { username }));
      db.delete(certificates).where(eq(certificates.username, username)).run();
      db.delete(accounts).where(eq(accounts.username, username)).run();
    }

    const steps: JobStep[] = [
      {
        name: "Create the user, its directories and its quota",
        run: async () => { await agent.call("account.create", { username, quotaMb: plan.account.quotaMb }); },
        compensate: undo,
      },
      {
        name: "Register domains, environments and apps",
        run: async () => {
          db.transaction((tx) => {
            const a = plan.account;
            tx.insert(accounts).values({
              username, quotaMb: a.quotaMb, maxDomains: a.maxDomains, maxVhosts: a.maxVhosts, maxDatabases: a.maxDatabases,
              dbStorageMb: a.dbStorageMb, appMemoryMb: a.appMemoryMb, createdAt,
              redisMemoryMb: a.redisMemoryMb ?? DEFAULT_SERVICE_MEMORY_MB, memcachedMemoryMb: a.memcachedMemoryMb ?? DEFAULT_SERVICE_MEMORY_MB,
              hookDomain: a.hookDomain && fqdns.includes(a.hookDomain) ? a.hookDomain : null,
            }).run();
            for (const domain of plan.domains) tx.insert(domains).values({ fqdn: domain.fqdn, username, createdAt }).run();
            for (const row of plan.vhosts) {
              tx.insert(vhosts).values({ fqdn: row.fqdn, username, domain: row.domain, isMain: row.isMain, type: row.type, docRoot: row.docRoot, phpVersion: row.phpVersion, phpOptions: row.phpOptions, logLevel: row.logLevel, logDays: row.logDays, createdAt }).run();
            }
            for (const app of plan.apps) {
              tx.insert(apps).values({
                fqdn: app.row.fqdn, id: newIds.get(app.row.id)!, ...app.config, status: "new", currentRelease: null, commit: null,
                deployKey: app.key?.publicKey.trim() ?? null, webhookSecret: app.row.webhookSecret ?? null, createdAt,
              } as typeof apps.$inferInsert).run();
            }
            for (const env of plan.env) tx.insert(appEnv).values(env).run();
          });
        },
      },
      {
        name: "Install the certificates",
        run: async () => {
          for (const cert of plan.certificates) {
            const issued = await agent.call("cert.write", { zone: cert.zone, certPem: cert.cert, keyPem: cert.key });
            db.insert(certificates).values({ zone: cert.zone, username, names: issued.names, notAfter: issued.notAfter, originPull: cert.originPull }).run();
          }
        },
      },
      {
        name: "Prepare the apps",
        run: async () => {
          for (const app of plan.apps) {
            const id = newIds.get(app.row.id)!;
            await agent.call("app.prepare", { appId: id, username, fqdn: app.row.fqdn, runtime: app.config.runtime, runtimeVersion: app.config.runtimeVersion });
            if (app.key) await agent.call("migrate.deployKey", { appId: id, privateKey: app.key.privateKey, publicKey: app.key.publicKey });
            const envRows = plan.env.filter((env) => env.fqdn === app.row.fqdn);
            const pick = (scope: "runtime" | "build") => Object.fromEntries(envRows.filter((env) => env.scope === scope || env.scope === "both").map(({ key, value }) => [key, value]));
            await agent.call("app.env", { appId: id, runtime: pick("runtime"), build: pick("build") });
          }
        },
      },
      {
        name: "Publish the environments to OpenLiteSpeed",
        run: async () => {
          for (const fqdn of fqdns) {
            const row = db.select().from(vhosts).where(eq(vhosts.fqdn, fqdn)).get();
            if (row) await writeSite(row);
          }
          await syncSites({ restart: true });
        },
      },
      {
        name: "FTP with its existing password",
        run: async () => {
          if (!plan.ftpHash) return;
          await agent.call("migrate.ftpHash", { username, hash: plan.ftpHash });
          db.update(accounts).set({ ftpPasswordChangedAt: Date.now() }).where(eq(accounts.username, username)).run();
        },
      },
      {
        name: "Databases with their users and passwords",
        run: async () => {
          for (const database of plan.databases) {
            const hash = plan.mysqlHashes.get(database);
            if (!hash) throw new Error(`The backup does not contain the user of ${database}`);
            await agent.call("backup.recreateDatabase", { username, database, authHash: hash });
            db.insert(databases).values({ name: database, username, createdAt }).run();
            const dump = databaseParts.find((item) => item.database === database);
            if (dump) await agent.call("backup.restoreDatabase", { repo, username, snapshot: dump.id, database });
          }
        },
      },
      {
        name: "Copy the home directory files",
        run: async () => { await agent.call("backup.restoreFiles", { repo, username, snapshot: filesPart.id, path: "", mode: "inplace" }); },
      },
      {
        name: "Redis, Memcached and apps",
        run: async () => {
          const a = plan.account;
          for (const [service, enabled, memoryMb] of [["redis", a.redisEnabled, a.redisMemoryMb], ["memcached", a.memcachedEnabled, a.memcachedMemoryMb]] as const) {
            if (!enabled) continue;
            await agent.call("service.set", { username, service, enabled: true, memoryMb: memoryMb ?? DEFAULT_SERVICE_MEMORY_MB });
            db.update(accounts).set(service === "redis" ? { redisEnabled: true } : { memcachedEnabled: true }).where(eq(accounts.username, username)).run();
          }
          // The app code comes back from Git, like any deployment.
          for (const app of plan.apps) requestDeploy(app.row.fqdn, "migration from another server");
        },
      },
    ];
    const { id } = jobs.enqueue({ type: "account.import", title: `Migrate the account ${username}`, steps });
    audit(db, "account.import", `${username} from ${source.endpoint}/${source.bucket}/${source.prefix} (${run})`);
    return c.json({ jobId: id } satisfies JobCreatedDto, 202);
  });
}

/** What needs to be recreated, validated. Fails if the backup has something that cannot be used. */
function readPlan(manifest: BackupManifest) {
  const parsedAccount = accountRowSchema.safeParse(manifest.panel.account);
  if (!parsedAccount.success) throw new Error(`The backup has invalid account data: ${parsedAccount.error.issues[0]?.message ?? ""}`);
  const accountRow = parsedAccount.data;
  const vhostRows = rows(manifest, "vhosts", vhostRowSchema);
  const certRows = rows(manifest, "certificates", certRowSchema);
  const appRows = rows(manifest, "apps", appRowSchema);
  const keys = new Map(manifest.server.deployKeys.map((key) => [key.appId, key]));
  return {
    account: accountRow,
    domains: rows(manifest, "domains", domainRowSchema),
    vhosts: vhostRows,
    certificates: certRows.map((row) => {
      const secret = manifest.server.certificates.find((item) => item.zone === row.zone);
      if (!secret) throw new Error(`The backup does not contain the certificate key for ${row.zone}`);
      return { zone: row.zone, cert: secret.cert, key: secret.key, originPull: row.originPull ?? false };
    }),
    apps: appRows.map((row) => ({
      row,
      config: appConfigSchema.parse(Object.fromEntries(CONFIG_KEYS.map((key) => [key, (row as Record<string, unknown>)[key]]))) as z.infer<typeof appConfigSchema> & Partial<AppRow>,
      key: keys.get(row.id) ?? null,
    })),
    env: rows(manifest, "appEnv", envRowSchema),
    databases: rows(manifest, "databases", z.object({ name: dbFullNameSchema }).loose()).map(({ name }) => name),
    mysqlHashes: new Map(manifest.server.mysqlUsers.flatMap((user) => {
      const hash = authHashOf(user.createUser);
      return hash ? [[user.database, hash] as const] : [];
    })),
    ftpHash: manifest.server.ftpHash && ftpHashSchema.safeParse(manifest.server.ftpHash).success ? manifest.server.ftpHash : null,
  };
}
