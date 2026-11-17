import {
  appConfigSchema,
  appReservedMemory,
  authHashOf,
  backupSettingsSchema,
  docRootSchema,
  envKeySchema,
  envScopeSchema,
  envValueSchema,
  fqdnSchema,
  isPublishableDocRoot,
  logDaysSchema,
  logLevelSchema,
  phpOptionsSchema,
  phpVersionSchema,
  EXPORT_TTL_MS,
  exportIdSchema,
  type AccountExportDto,
  type BackupManifest,
  type BackupManifestSummaryDto,
  dbFullNameSchema,
  filePathSchema,
  restoreModeSchema,
  snapshotIdSchema,
  type BackupRunDto,
  type BackupSettingsDto,
  type BackupSnapshot,
  type JobCreatedDto,
  type ResticRepo,
} from "@eaglepanel/shared";
import { eq, inArray } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AgentClient } from "./agent-client";
import { audit } from "./audit";
import type { Db } from "./db";
import { accountExports, accounts, appEnv, apps, certificates, databases, domains, settings, vhosts } from "./db/schema";
import type { JobRunner, JobStep } from "./jobs";

/**
 * Backups: storage settings, the daily run and restores. The heavy lifting is done by the agent with restic;
 * here the panel decides what goes in and builds the part of the manifest that lives in the panel database.
 */

const KEY = {
  enabled: "backup.enabled",
  endpoint: "backup.endpoint",
  bucket: "backup.bucket",
  prefix: "backup.prefix",
  region: "backup.region",
  accessKeyId: "backup.accessKeyId",
  secretAccessKey: "backup.secretAccessKey",
  password: "backup.repositoryPassword",
  hour: "backup.hour",
  lastRun: "backup.lastRun",
  lastScheduledDay: "backup.lastScheduledDay",
} as const;

type VhostRow = typeof vhosts.$inferSelect;

export interface BackupDeps {
  db: Db;
  agent: AgentClient;
  jobs: JobRunner;
  /** To apply restored environment options: the same functions the rest of the panel uses. */
  writeSite?: (row: VhostRow) => Promise<void>;
  syncSites?: (options?: { exclude?: string[]; restart?: boolean }) => Promise<void>;
}

const restoreFilesSchema = z.object({ snapshot: snapshotIdSchema, path: filePathSchema, mode: restoreModeSchema }).strict();
/** `manifest` is needed only if the database no longer exists: its user with the original password comes from there. */
const restoreDatabaseSchema = z.object({ snapshot: snapshotIdSchema, database: dbFullNameSchema, manifest: snapshotIdSchema.optional() }).strict();
const configPartSchema = z.enum(["env", "options", "app"]);
const restoreConfigSchema = z.object({ manifest: snapshotIdSchema, fqdns: z.array(fqdnSchema).min(1).max(1000), parts: z.array(configPartSchema).min(1) }).strict();

/** Manifest rows come from an own, encrypted backup; they are validated anyway before going back into the database. */
const manifestVhostSchema = z.object({ fqdn: fqdnSchema, type: z.enum(["php", "app"]), docRoot: docRootSchema, phpVersion: phpVersionSchema, phpOptions: phpOptionsSchema, logLevel: logLevelSchema, logDays: logDaysSchema }).loose();
const manifestEnvSchema = z.object({ fqdn: fqdnSchema, key: envKeySchema, value: envValueSchema, scope: envScopeSchema });
const manifestAppSchema = z.object({ fqdn: fqdnSchema, config: appConfigSchema });
/** To connect a new server to an existing repository: the password it was created with. */
const settingsBodySchema = backupSettingsSchema.extend({ repositoryPassword: z.string().min(16).max(256).optional() }).strict();

/** An app's configuration fields, taken from its row. */
function pickConfig(row: Record<string, unknown>) {
  const keys = ["kind", "repoUrl", "branch", "subdir", "runtime", "runtimeVersion", "buildCommand", "startCommand", "outputDir", "spaFallback", "healthPath", "memoryMb"] as const;
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

/** `20261107T030000Z`: sorts correctly as text and has no odd characters for a restic tag. */
export const runIdOf = (time: number) => new Date(time).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export function createBackups({ db, agent, jobs, writeSite, syncSites }: BackupDeps) {
  const get = (key: string) => db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
  const set = (key: string, value: string | null) => {
    if (value === null) db.delete(settings).where(eq(settings.key, key)).run();
    else db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  };

  /** The repository, if configured. */
  function repo(): ResticRepo | null {
    const endpoint = get(KEY.endpoint);
    const bucket = get(KEY.bucket);
    const prefix = get(KEY.prefix);
    const password = get(KEY.password);
    if (!endpoint || !bucket || !prefix || !password) return null;
    return {
      repository: `s3:${endpoint}/${bucket}/${prefix}`,
      password,
      accessKeyId: get(KEY.accessKeyId) ?? undefined,
      secretAccessKey: get(KEY.secretAccessKey) ?? undefined,
      region: get(KEY.region) ?? undefined,
    };
  }

  function settingsDto(): BackupSettingsDto {
    const lastRun = get(KEY.lastRun);
    return {
      configured: repo() !== null,
      enabled: get(KEY.enabled) === "1",
      endpoint: get(KEY.endpoint) ?? "",
      bucket: get(KEY.bucket) ?? "",
      prefix: get(KEY.prefix) ?? "",
      region: get(KEY.region) ?? "auto",
      accessKeyId: get(KEY.accessKeyId) ?? "",
      hasSecret: get(KEY.secretAccessKey) !== null,
      hour: Number(get(KEY.hour) ?? 3),
      lastRun: lastRun ? (JSON.parse(lastRun) as BackupSettingsDto["lastRun"]) : null,
      pendingPurges: pendingPurges(),
    };
  }

  // A deleted account ceases to exist along with its backups. If deleting them fails (the bucket does not respond),
  // it is recorded and retried on every full run until it succeeds.
  const PURGE_PREFIX = "backup.purge:";
  const pendingPurges = () => db.select().from(settings).all().filter(({ key }) => key.startsWith(PURGE_PREFIX)).map(({ key }) => key.slice(PURGE_PREFIX.length));

  async function purge(username: string): Promise<void> {
    const repository = repo();
    const before = Number(get(`${PURGE_PREFIX}${username}`) ?? Date.now());
    if (repository) await agent.call("backup.purge", { repo: repository, username, before });
    set(`${PURGE_PREFIX}${username}`, null);
  }

  /**
   * Last step of deleting an account. It does not fail: if it did, the job would undo the previous steps and publish
   * again the environments of an already deleted account. It is recorded, visible in Settings, and retried every night.
   */
  function purgeStep(username: string): JobStep {
    return {
      name: "Delete its backups",
      run: async () => {
        set(`${PURGE_PREFIX}${username}`, String(Date.now()));
        try {
          await purge(username);
        } catch (error) {
          audit(db, "backup.purge.pending", `${username}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000));
        }
      },
    };
  }

  /** What the panel knows about the account. With this and the server secrets it can be recreated. */
  function panelPart(username: string) {
    const account = db.select().from(accounts).where(eq(accounts.username, username)).get();
    const accountVhosts = db.select().from(vhosts).where(eq(vhosts.username, username)).all();
    const fqdns = accountVhosts.map(({ fqdn }) => fqdn);
    const accountApps = fqdns.length ? db.select().from(apps).where(inArray(apps.fqdn, fqdns)).all() : [];
    return {
      account,
      domains: db.select().from(domains).where(eq(domains.username, username)).all(),
      vhosts: accountVhosts,
      certificates: db.select().from(certificates).where(eq(certificates.username, username)).all(),
      databases: db.select().from(databases).where(eq(databases.username, username)).all(),
      apps: accountApps,
      appEnv: fqdns.length ? db.select().from(appEnv).where(inArray(appEnv.fqdn, fqdns)).all() : [],
    };
  }

  function accountStep(repository: ResticRepo, username: string, run: string, failures: string[]): JobStep {
    return {
      name: `Back up ${username}`,
      // A failing account does not stop the others: it is recorded and the job ends marked as failed.
      run: async () => {
        try {
          const panel = panelPart(username);
          // It was deleted while waiting for its turn: no new backups are created for an account that no longer exists.
          if (!panel.account) return;
          await agent.call("backup.account", {
            repo: repository,
            username,
            run,
            panel: JSON.stringify(panel),
            databases: panel.databases.map(({ name }) => name),
            zones: panel.certificates.map(({ zone }) => zone),
            appIds: panel.apps.map(({ id }) => id),
          });
        } catch (error) {
          failures.push(`${username}: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };
  }

  /** Queues a run: every account, or only the requested ones. */
  function enqueueRun(trigger: string, only?: string[]): { jobId: string } | { error: string } {
    const repository = repo();
    if (!repository) return { error: "Configure the backup storage first" };
    const time = Date.now();
    const run = runIdOf(time);
    // Suspended accounts are not backed up: their previous backups stay until the retention policy expires them.
    const usernames = only ?? db.select({ username: accounts.username }).from(accounts).where(eq(accounts.suspended, false)).all().map(({ username }) => username);
    const failures: string[] = [];
    const steps: JobStep[] = [
      { name: "Open the repository", run: async () => { await agent.call("backup.init", { repo: repository }); } },
      ...usernames.map((username) => accountStep(repository, username, run, failures)),
    ];
    // Retention only on the full run: a manual backup of one account deletes nothing.
    if (!only) {
      steps.push({
        name: "Delete the backups of deleted accounts",
        run: async () => {
          for (const username of pendingPurges()) {
            try {
              await purge(username);
            } catch (error) {
              failures.push(`${username} (eliminada): ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        },
      });
      steps.push({ name: "Apply the retention policy", run: async () => { await agent.call("backup.forget", { repo: repository }); } });
    }
    steps.push({
      name: "Record the result",
      run: async () => {
        const detail = failures.length ? failures.join(" · ").slice(0, 2000) : `${usernames.length} account(s)`;
        if (!only) set(KEY.lastRun, JSON.stringify({ at: time, ok: failures.length === 0, detail }));
        if (failures.length) throw new Error(`${failures.length} account(s) failed: ${detail}`);
      },
    });
    const { id } = jobs.enqueue({ type: "backup.run", title: only ? `Back up ${only.join(", ")}` : "Back up all accounts", steps }, { lane: "backup" });
    audit(db, "backup.run", `${run} (${trigger})${only ? `: ${only.join(", ")}` : ""}`);
    return { jobId: id };
  }

  /** Groups an account's snapshots into backups: one per run. */
  function toRuns(snapshots: BackupSnapshot[]): BackupRunDto[] {
    const byRun = new Map<string, BackupRunDto>();
    for (const item of snapshots) {
      const entry = byRun.get(item.run) ?? { run: item.run, time: item.time, files: null, manifest: null, databases: [], sizeBytes: null };
      if (item.part === "files") {
        entry.files = item.id;
        entry.sizeBytes = item.sizeBytes;
      } else if (item.part === "manifest") {
        entry.manifest = item.id;
      } else if (item.database) {
        entry.databases.push({ name: item.database, snapshot: item.id });
      }
      entry.time = Math.min(entry.time, item.time);
      byRun.set(item.run, entry);
    }
    return [...byRun.values()].sort((a, b) => b.time - a.time);
  }

  function register(routes: Hono, startJob: (c: Context, type: string, title: string, steps: JobStep[], detail: string, secret?: string) => Response | Promise<Response>) {
    routes.get("/settings/backups", (c) => c.json(settingsDto()));

    routes.post("/settings/backups", async (c) => {
      const body = settingsBodySchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid data" }, 400);
      const data = body.data;
      const secret = data.secretAccessKey || get(KEY.secretAccessKey);
      if (!secret) return c.json({ error: "The secret key is missing" }, 400);
      const previous = Object.fromEntries(Object.values(KEY).map((key) => [key, get(key)]));
      // The repository password is generated by the panel, unless connecting to an existing one. It is never changed
      // afterwards: backups made with it could no longer be read.
      const existing = get(KEY.password);
      const password = existing ?? data.repositoryPassword ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      const generated = existing === null && data.repositoryPassword === undefined;
      const save = () => {
        set(KEY.enabled, data.enabled ? "1" : "0");
        set(KEY.endpoint, data.endpoint);
        set(KEY.bucket, data.bucket);
        set(KEY.prefix, data.prefix);
        set(KEY.region, data.region);
        set(KEY.accessKeyId, data.accessKeyId);
        set(KEY.secretAccessKey, secret);
        set(KEY.password, password);
        set(KEY.hour, String(data.hour));
      };
      return startJob(c, "backup.settings", "Configure the backup storage", [{
        name: "Save and open or create the repository",
        run: async () => {
          save();
          await agent.call("backup.init", { repo: repo()! });
        },
        compensate: async () => {
          for (const [key, value] of Object.entries(previous)) set(key, value);
        },
      }], `${data.endpoint}/${data.bucket}/${data.prefix}`, generated ? password : undefined);
    });

    routes.post("/backups/run", (c) => {
      const result = enqueueRun("manual");
      return "error" in result ? c.json(result, 409) : c.json(result satisfies JobCreatedDto, 202);
    });

    routes.post("/accounts/:username/backups/run", (c) => {
      const username = c.req.param("username");
      const account = db.select().from(accounts).where(eq(accounts.username, username)).get();
      if (!account) return c.json({ error: "Not found" }, 404);
      if (account.suspended) return c.json({ error: "The account is suspended: it is not backed up" }, 409);
      const result = enqueueRun("manual", [username]);
      return "error" in result ? c.json(result, 409) : c.json(result satisfies JobCreatedDto, 202);
    });

    routes.get("/accounts/:username/backups", async (c) => {
      const repository = repo();
      if (!repository) return c.json([] satisfies BackupRunDto[]);
      try {
        const { snapshots } = await agent.call("backup.snapshots", { repo: repository, username: c.req.param("username") });
        return c.json(toRuns(snapshots) satisfies BackupRunDto[]);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Could not read the repository" }, 502);
      }
    });

    routes.post("/accounts/:username/backups/restore-files", async (c) => {
      const username = c.req.param("username");
      const repository = repo();
      if (!repository) return c.json({ error: "Backups are not configured" }, 409);
      if (!db.select().from(accounts).where(eq(accounts.username, username)).get()) return c.json({ error: "Not found" }, 404);
      const body = restoreFilesSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid data" }, 400);
      const { snapshot, path, mode } = body.data;
      const { id } = jobs.enqueue({
        type: "backup.restoreFiles",
        title: `Restore ${path || "the home directory"} of ${username}`,
        steps: [{ name: mode === "folder" ? "Restore into a new directory" : "Restore over the current files", run: async () => { await agent.call("backup.restoreFiles", { repo: repository, username, snapshot, path, mode }); } }],
      }, { lane: "backup" });
      audit(db, "backup.restoreFiles", `${username}: ${path || "home"} from ${snapshot.slice(0, 8)} (${mode === "folder" ? "new directory" : "in place"})`);
      return c.json({ jobId: id } satisfies JobCreatedDto, 202);
    });


    // What a backup contains, without values or secrets: to choose what to restore.
    routes.get("/accounts/:username/backups/manifest/:snapshot", async (c) => {
      const username = c.req.param("username");
      const repository = repo();
      const snapshot = snapshotIdSchema.safeParse(c.req.param("snapshot"));
      if (!repository || !snapshot.success) return c.json({ error: "Not found" }, 404);
      try {
        const manifest = await manifestOf(repository, snapshot.data, username);
        const current = new Map(db.select().from(vhosts).where(eq(vhosts.username, username)).all().map((row) => [row.fqdn, row]));
        const envRows = rowsOf(manifest, "appEnv", manifestEnvSchema);
        const appRows = appsOf(manifest);
        const users = new Map(manifest.server.mysqlUsers.map((user) => [user.database, authHashOf(user.createUser) !== null]));
        return c.json({
          vhosts: rowsOf(manifest, "vhosts", manifestVhostSchema).map((row) => {
            const saved = appRows.find((app) => app.fqdn === row.fqdn);
            const now = db.select().from(apps).where(eq(apps.fqdn, row.fqdn)).get();
            return {
              fqdn: row.fqdn,
              type: row.type,
              exists: current.has(row.fqdn),
              sameType: current.get(row.fqdn)?.type === row.type,
              envKeys: envRows.filter((env) => env.fqdn === row.fqdn).map(({ key }) => key),
              app: saved !== undefined && now?.kind === saved.config.kind,
            };
          }),
          databases: rowsOf(manifest, "databases", z.object({ name: dbFullNameSchema })).map(({ name }) => ({
            name,
            exists: db.select().from(databases).where(eq(databases.name, name)).get() !== undefined,
            hasUser: users.get(name) ?? false,
          })),
        } satisfies BackupManifestSummaryDto);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Could not read the backup" }, 400);
      }
    });

    /** Variables, environment options and app configuration, for the environments that still exist. */
    routes.post("/accounts/:username/backups/restore-config", async (c) => {
      const username = c.req.param("username");
      const repository = repo();
      if (!repository) return c.json({ error: "Backups are not configured" }, 409);
      const account = db.select().from(accounts).where(eq(accounts.username, username)).get();
      if (!account) return c.json({ error: "Not found" }, 404);
      const body = restoreConfigSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid data" }, 400);
      const { manifest: snapshot, fqdns, parts } = body.data;
      let manifest: BackupManifest;
      try {
        manifest = await manifestOf(repository, snapshot, username);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Could not read the backup" }, 400);
      }
      const savedVhosts = rowsOf(manifest, "vhosts", manifestVhostSchema);
      const savedEnv = rowsOf(manifest, "appEnv", manifestEnvSchema);
      const savedApps = appsOf(manifest);

      const steps: JobStep[] = [];
      for (const fqdn of fqdns) {
        const now = db.select().from(vhosts).where(eq(vhosts.fqdn, fqdn)).get();
        const then = savedVhosts.find((row) => row.fqdn === fqdn);
        if (!now || now.username !== username || !then) return c.json({ error: `${fqdn} is not in the account or in the backup` }, 400);
        if (now.type !== then.type) return c.json({ error: `${fqdn} changed type since that backup` }, 409);

        if (parts.includes("options") && now.type === "php" && writeSite && syncSites) {
          if (!isPublishableDocRoot(then.docRoot)) return c.json({ error: `${fqdn}: the backup directory is private` }, 400);
          const previous = { docRoot: now.docRoot, phpVersion: now.phpVersion, phpOptions: now.phpOptions, logLevel: now.logLevel, logDays: now.logDays };
          const restored = { docRoot: then.docRoot, phpVersion: then.phpVersion, phpOptions: then.phpOptions, logLevel: then.logLevel, logDays: then.logDays };
          const site = { write: writeSite, sync: syncSites };
          const apply = async (next: typeof previous) => {
            await site.write({ ...now, ...next });
            await site.sync({ restart: true });
            await agent.call("php.restart", { username });
            db.update(vhosts).set(next).where(eq(vhosts.fqdn, fqdn)).run();
          };
          steps.push({ name: `Options of ${fqdn}`, run: () => apply(restored), compensate: () => apply(previous) });
        }

        const appNow = db.select().from(apps).where(eq(apps.fqdn, fqdn)).get();
        if (parts.includes("env") && appNow) {
          const previous = db.select().from(appEnv).where(eq(appEnv.fqdn, fqdn)).all();
          const replace = async (rows: { key: string; value: string; scope: "runtime" | "build" | "both" }[]) => {
            db.transaction((tx) => {
              tx.delete(appEnv).where(eq(appEnv.fqdn, fqdn)).run();
              for (const row of rows) tx.insert(appEnv).values({ fqdn, key: row.key, value: row.value, scope: row.scope }).run();
            });
            await agent.call("app.env", { appId: appNow.id, ...envFor(fqdn) });
          };
          // They apply on the next deployment or restart, the same as when saved by hand.
          steps.push({ name: `Variables of ${fqdn}`, run: () => replace(savedEnv.filter((row) => row.fqdn === fqdn)), compensate: () => replace(previous) });
        }

        const appThen = savedApps.find((row) => row.fqdn === fqdn);
        if (parts.includes("app") && appNow && appThen) {
          if (appThen.config.kind !== appNow.kind) return c.json({ error: `${fqdn}: the app changed type since that backup` }, 409);
          const accountFqdns = new Set(db.select({ fqdn: vhosts.fqdn }).from(vhosts).where(eq(vhosts.username, username)).all().map((row) => row.fqdn));
          const used = db.select().from(apps).all().filter((row) => row.fqdn !== fqdn && accountFqdns.has(row.fqdn)).reduce((total, row) => total + appReservedMemory(row), 0);
          if (used + appReservedMemory(appThen.config) > account.appMemoryMb) return c.json({ error: `${fqdn}: the backup memory exceeds what the account has available` }, 409);
          const previous = pickConfig(appNow) as typeof appThen.config;
          const apply = async (next: typeof previous) => {
            db.update(apps).set(next).where(eq(apps.fqdn, fqdn)).run();
            await agent.call("app.prepare", { appId: appNow.id, username, fqdn, runtime: next.runtime, runtimeVersion: next.runtimeVersion });
          };
          // The configuration applies from the next deployment: nothing is rebuilt here.
          steps.push({ name: `App configuration of ${fqdn}`, run: () => apply(appThen.config), compensate: () => apply(previous) });
        }
      }
      if (steps.length === 0) return c.json({ error: "Nothing to restore with that selection" }, 400);
      const { id } = jobs.enqueue({ type: "backup.restoreConfig", title: `Restore configuration of ${username}`, steps });
      audit(db, "backup.restoreConfig", `${username}: ${parts.join(", ")} of ${fqdns.join(", ")} from ${snapshot.slice(0, 8)}`);
      return c.json({ jobId: id } satisfies JobCreatedDto, 202);
    });


    routes.get("/accounts/:username/exports", (c) => {
      const rows = db.select().from(accountExports).where(eq(accountExports.username, c.req.param("username"))).all();
      return c.json(rows.map(({ id, createdAt, expiresAt, sizeBytes, status }) => ({ id, createdAt, expiresAt, sizeBytes, status })).sort((a, b) => b.createdAt - a.createdAt) satisfies AccountExportDto[]);
    });

    // Also for a suspended account: this is how it takes its files. One copy at a time; the new one replaces the previous one.
    routes.post("/accounts/:username/exports", (c) => {
      const username = c.req.param("username");
      if (!db.select().from(accounts).where(eq(accounts.username, username)).get()) return c.json({ error: "Not found" }, 404);
      const previous = db.select().from(accountExports).where(eq(accountExports.username, username)).all();
      if (previous.some((row) => row.status === "running")) return c.json({ error: "A copy is already being built" }, 409);
      const id = crypto.randomUUID().replaceAll("-", "");
      const createdAt = Date.now();
      db.insert(accountExports).values({ id, username, status: "running", createdAt, expiresAt: createdAt + EXPORT_TTL_MS }).run();
      const { id: jobId } = jobs.enqueue({
        type: "account.export",
        title: `Downloadable copy of ${username}`,
        steps: [
          { name: "Delete the previous copy", run: async () => { for (const row of previous) await dropExport(row.id); } },
          {
            name: "Build the copy: files and databases",
            run: async () => {
              const names = db.select({ name: databases.name }).from(databases).where(eq(databases.username, username)).all().map(({ name }) => name);
              const { sizeBytes } = await agent.call("export.create", { username, id, databases: names });
              // Expires 24 h after being ready, not after being requested.
              db.update(accountExports).set({ status: "ready", sizeBytes, expiresAt: Date.now() + EXPORT_TTL_MS }).where(eq(accountExports.id, id)).run();
            },
            compensate: async () => {
              db.update(accountExports).set({ status: "failed" }).where(eq(accountExports.id, id)).run();
              await agent.call("export.delete", { id }).catch(() => undefined);
            },
          },
        ],
      }, { lane: "backup" });
      audit(db, "account.export", username);
      return c.json({ jobId } satisfies JobCreatedDto, 202);
    });

    routes.get("/accounts/:username/exports/:id/download", async (c) => {
      const username = c.req.param("username");
      const id = exportIdSchema.safeParse(c.req.param("id"));
      if (!id.success || !agent.stream) return c.json({ error: "Not found" }, 404);
      const row = db.select().from(accountExports).where(eq(accountExports.id, id.data)).get();
      if (!row || row.username !== username || row.status !== "ready" || row.expiresAt <= Date.now()) return c.json({ error: "That copy is not available" }, 404);
      const response = await agent.stream("/exports/download", { id: id.data });
      if (!response.ok) return c.json({ error: "That copy is no longer on the server" }, 404);
      const date = new Date(row.createdAt).toISOString().slice(0, 10);
      audit(db, "account.export.download", username);
      return new Response(response.body, {
        headers: {
          "content-type": "application/gzip",
          "content-length": response.headers.get("content-length") ?? "",
          "content-disposition": `attachment; filename="${username}-${date}.tar.gz"`,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      });
    });

    routes.post("/accounts/:username/exports/:id/delete", async (c) => {
      const id = exportIdSchema.safeParse(c.req.param("id"));
      const row = id.success ? db.select().from(accountExports).where(eq(accountExports.id, id.data)).get() : undefined;
      if (!row || row.username !== c.req.param("username") || row.status === "running") return c.json({ error: "Not found" }, 404);
      try {
        await dropExport(row.id);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Could not delete" }, 502);
      }
      return c.json({ ok: true });
    });

    routes.post("/accounts/:username/backups/restore-database", async (c) => {
      const username = c.req.param("username");
      const repository = repo();
      if (!repository) return c.json({ error: "Backups are not configured" }, 409);
      const body = restoreDatabaseSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid data" }, 400);
      const { snapshot, database, manifest: manifestSnapshot } = body.data;
      const account = db.select().from(accounts).where(eq(accounts.username, username)).get();
      if (!account || !database.startsWith(`${username}_`)) return c.json({ error: "That database does not belong to the account" }, 404);
      const row = db.select().from(databases).where(eq(databases.name, database)).get();
      if (row && row.username !== username) return c.json({ error: "That database does not belong to the account" }, 404);
      const steps: JobStep[] = [];
      if (!row) {
        // It was deleted from the panel: it is recreated with its user and the password it had, so the site reconnects.
        if (!manifestSnapshot) return c.json({ error: "That database no longer exists: the full backup is needed to recreate it" }, 400);
        if (account.suspended) return c.json({ error: "The account is suspended" }, 409);
        if (db.select().from(databases).where(eq(databases.username, username)).all().length >= account.maxDatabases) {
          return c.json({ error: `The account reached its limit of ${account.maxDatabases} databases` }, 409);
        }
        let authHash: string | null = null;
        try {
          const manifest = await manifestOf(repository, manifestSnapshot, username);
          const user = manifest.server.mysqlUsers.find((item) => item.database === database);
          authHash = user ? authHashOf(user.createUser) : null;
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : "Could not read the backup" }, 400);
        }
        if (!authHash) return c.json({ error: "The backup does not contain that database's user" }, 409);
        const hash = authHash;
        steps.push({
          name: "Recreate the database and its user with its password",
          run: async () => {
            await agent.call("backup.recreateDatabase", { username, database, authHash: hash });
            db.insert(databases).values({ name: database, username, createdAt: Date.now() }).run();
          },
          compensate: async () => {
            await agent.call("db.delete", { username, name: database.slice(username.length + 1) });
            db.delete(databases).where(eq(databases.name, database)).run();
          },
        });
      }
      steps.push({ name: "Empty the database and load the backup", run: async () => { await agent.call("backup.restoreDatabase", { repo: repository, username, snapshot, database }); } });
      const { id } = jobs.enqueue({ type: "backup.restoreDatabase", title: `Restore the database ${database}`, steps }, { lane: "backup" });
      audit(db, "backup.restoreDatabase", `${database} from ${snapshot.slice(0, 8)}`);
      return c.json({ jobId: id } satisfies JobCreatedDto, 202);
    });
  }

  /** Reads the manifest and checks that it belongs to this account. */
  async function manifestOf(repository: ResticRepo, snapshot: string, username: string): Promise<BackupManifest> {
    const { manifest } = await agent.call("backup.manifest", { repo: repository, snapshot });
    if (manifest.username !== username) throw new Error("That backup does not belong to this account");
    return manifest;
  }

  const rowsOf = <T>(manifest: BackupManifest, key: string, schema: z.ZodType<T>): T[] =>
    (Array.isArray(manifest.panel[key]) ? (manifest.panel[key] as unknown[]) : []).flatMap((row) => {
      const parsed = schema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });

  /** The manifest apps, with their configuration validated like the form's. */
  const appsOf = (manifest: BackupManifest) => (Array.isArray(manifest.panel.apps) ? (manifest.panel.apps as Record<string, unknown>[]) : []).flatMap((row) => {
    const parsed = manifestAppSchema.safeParse({ fqdn: row.fqdn, config: pickConfig(row) });
    return parsed.success ? [parsed.data] : [];
  });

  const envFor = (fqdn: string) => {
    const rows = db.select().from(appEnv).where(eq(appEnv.fqdn, fqdn)).all();
    const pick = (scope: "runtime" | "build") => Object.fromEntries(rows.filter((row) => row.scope === scope || row.scope === "both").map(({ key, value }) => [key, value]));
    return { runtime: pick("runtime"), build: pick("build") };
  };

  // ---------------------------------------------------------------------------- Downloadable copies

  /** Deletes the file and the row. If the agent fails, the row stays and is retried when it expires. */
  async function dropExport(id: string): Promise<void> {
    await agent.call("export.delete", { id });
    db.delete(accountExports).where(eq(accountExports.id, id)).run();
  }

  /** When deleting an account: its copies go with it. */
  async function dropExportsOf(username: string): Promise<void> {
    for (const row of db.select().from(accountExports).where(eq(accountExports.username, username)).all()) await dropExport(row.id).catch(() => undefined);
  }

  async function expireExports(now = Date.now()): Promise<void> {
    for (const row of db.select().from(accountExports).all()) {
      if (row.expiresAt <= now) await dropExport(row.id).catch((error: unknown) => console.error("[api] could not delete an expired copy:", error));
    }
  }

  /** Checks every minute whether the daily backup time has come. Once a day, even if the panel restarts. */
  function tick(now = new Date()) {
    void expireExports(now.getTime());
    if (get(KEY.enabled) !== "1" || !repo()) return;
    // Local day, like the hour: with the UTC day, near midnight a backup would be skipped or repeated.
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (now.getHours() !== Number(get(KEY.hour) ?? 3) || get(KEY.lastScheduledDay) === day) return;
    set(KEY.lastScheduledDay, day);
    enqueueRun("programado");
  }

  return {
    register,
    enqueueRun,
    purgeStep,
    dropExportsOf,
    expireExports,
    repo,
    tick,
    startScheduler() {
      const timer = setInterval(() => {
        try {
          tick();
        } catch (error) {
          console.error("[api] could not schedule the backup:", error);
        }
      }, 60_000);
      return () => clearInterval(timer);
    },
  };
}
