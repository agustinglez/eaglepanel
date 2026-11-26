import { z } from "zod";
import {
  appCommandSchema,
  appIdSchema,
  appKindSchema,
  appMemorySchema,
  appRuntimeSchema,
  outputDirSchema,
  branchSchema,
  envVarsSchema,
  healthPathSchema,
  repoSubdirSchema,
  repoUrlSchema,
  runtimeVersionSchema,
  type AppConfig,
  type EnvScope,
  accountServiceSchema,
  dbFullNameSchema,
  dbNameSchema,
  docRootSchema,
  fqdnSchema,
  redirectTargetSchema,
  vhostSlugSchema,
  generatedSecretSchema,
  logDaysSchema,
  logLevelSchema,
  logLinesSchema,
  logSourceSchema,
  pemSchema,
  phpOptionsSchema,
  phpVersionSchema,
  quotaMbSchema,
  serviceMemorySchema,
  usernameSchema,
  type AccountLimits,
  type AccountService,
  type HostnameMode,
  type LogLevel,
  type PhpOptions,
} from "./validators";
import { fileRequestSchema } from "./files";
import { backupOps } from "./backups";
import { dbAdminOps } from "./dbadmin";
import { packageOps } from "./packages";
import { wordpressOps } from "./wordpress";
import { mailOps } from "./mail";

const ok = z.object({ ok: z.literal(true) });
/**
 * Memory settings of MySQL or MariaDB (eaglepanel-tuning.cnf). Small by default: a hosting server's databases are
 * usually small, and every MB reserved here is RAM the sites do not have. `xProtocol`: MySQL's X plugin (MySQL Shell,
 * document store), which PHP and WordPress do not use; MariaDB has none.
 */
export const dbTuningSchema = z.object({
  bufferPoolMb: z.number().int().min(16, "At least 16 MB").max(32768),
  logBufferMb: z.number().int().min(1).max(512),
  maxConnections: z.number().int().min(10, "At least 10 connections").max(2000),
  tableOpenCache: z.number().int().min(100).max(20000),
  tableDefinitionCache: z.number().int().min(400, "At least 400").max(20000),
  xProtocol: z.boolean(),
}).strict();
export type DbTuning = z.infer<typeof dbTuningSchema>;
/** What the installer writes. The same values as deploy/install.sh (a test checks it). */
export const DEFAULT_DB_TUNING: DbTuning = { bufferPoolMb: 64, logBufferMb: 8, maxConnections: 50, tableOpenCache: 400, tableDefinitionCache: 400, xProtocol: false };

/**
 * performance_schema and memory of the database server. `engine`: what the installer set up, MySQL or MariaDB.
 * `tuning`: what the file says (null: no file, the server's own defaults); `tuningRunning`: what runs now.
 */
const mysqlDiagnosticsSchema = z.object({
  engine: z.enum(["mysql", "mariadb"]),
  running: z.boolean().nullable(),
  configured: z.boolean(),
  memoryMb: z.number().nullable(),
  ramMb: z.number().nullable(),
  tuning: dbTuningSchema.nullable(),
  tuningRunning: dbTuningSchema.nullable(),
});

/** A full git commit: what GitHub sends in `after`. */
export const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
export type VhostType = "php" | "app";

/**
 * Closed list of agent operations. Each phase adds its own here.
 * There must never be an operation that receives an arbitrary command.
 */
export const agentOps = {
  "system.ping": {
    params: z.object({}).strict(),
    result: z.object({ pong: z.literal(true), sandbox: z.boolean() }),
  },
  "system.info": {
    params: z.object({}).strict(),
    result: z.object({
      hostname: z.string(),
      platform: z.string(),
      release: z.string(),
      /** Distribution name from /etc/os-release, such as "Ubuntu 24.04.1 LTS". Null where it does not exist. */
      osName: z.string().nullable(),
      uptimeSeconds: z.number(),
      loadAverage: z.array(z.number()),
      memory: z.object({ totalBytes: z.number(), freeBytes: z.number() }),
      sandbox: z.boolean(),
    }),
  },
  "system.preflight": {
    params: z.object({}).strict(),
    result: z.object({
      ok: z.boolean(),
      checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
    }),
  },
  "php.versions": {
    params: z.object({}).strict(),
    result: z.object({ versions: z.array(phpVersionSchema) }),
  },
  "account.create": {
    params: z.object({ username: usernameSchema, quotaMb: quotaMbSchema }).strict(),
    result: ok,
  },
  "account.delete": {
    params: z.object({ username: usernameSchema }).strict(),
    result: ok,
  },
  "account.setQuota": {
    params: z.object({ username: usernameSchema, quotaMb: quotaMbSchema }).strict(),
    result: ok,
  },
  "site.write": {
    params: z.object({
      username: usernameSchema,
      site: vhostSlugSchema,
      docRoot: docRootSchema,
      phpVersion: phpVersionSchema,
      phpOptions: phpOptionsSchema,
      certZone: fqdnSchema.nullable(),
      originPull: z.boolean(),
      logLevel: logLevelSchema,
      logDays: logDaysSchema,
      suspended: z.boolean(),
      /**
       * With this the environment does not run PHP. `server` is a proxy to its container; `static` publishes a built
       * release, or nothing if there is none yet.
       */
      app: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("server"), id: appIdSchema }).strict(),
        z.object({ kind: z.literal("static"), id: appIdSchema, release: z.number().int().min(1).nullable(), spaFallback: z.boolean() }).strict(),
      ]).nullable(),
      /** It is its account's webhook domain: publishes HOOK_PATH to the panel. */
      hooks: z.boolean(),
    }).strict(),
    result: ok,
  },
  "app.prepare": {
    params: z.object({ appId: appIdSchema, username: usernameSchema, runtime: appRuntimeSchema, runtimeVersion: runtimeVersionSchema }).strict(),
    result: ok,
  },
  "app.deployKey": {
    params: z.object({ appId: appIdSchema }).strict(),
    result: z.object({ publicKey: z.string() }),
  },
  "app.fetch": {
    /** With `commit`, that commit is deployed instead of the branch tip: it must be part of the branch. */
    params: z.object({ appId: appIdSchema, repoUrl: repoUrlSchema, branch: branchSchema, commit: commitSchema.optional() }).strict(),
    result: z.object({ commit: z.string(), message: z.string() }),
  },
  /** Puts the commit code in the build directory, emptied first: every deployment builds from scratch. */
  "app.unpack": {
    params: z.object({ appId: appIdSchema, username: usernameSchema, commit: commitSchema, subdir: repoSubdirSchema }).strict(),
    result: ok,
  },
  /** Runs the account's build command in a container, on this release's code. */
  "app.build": {
    params: z.object({
      appId: appIdSchema,
      username: usernameSchema,
      command: appCommandSchema,
      runtime: appRuntimeSchema,
      runtimeVersion: runtimeVersionSchema,
    }).strict(),
    /** The panel decides what to do with the result: a failing build is not an agent error. */
    result: z.object({ code: z.number(), log: z.string() }),
  },
  /** Stores the build result as a release: the published files of a static site, or the image of a server. */
  "app.release": {
    params: z.object({
      appId: appIdSchema,
      username: usernameSchema,
      release: z.number().int().min(1),
      kind: appKindSchema,
      outputDir: outputDirSchema,
      runtime: appRuntimeSchema,
      runtimeVersion: runtimeVersionSchema,
    }).strict(),
    result: z.object({ files: z.number(), bytes: z.number() }),
  },
  /** Servers only: starts the release in the other slot and, if it responds, sends traffic to it. */
  "app.activate": {
    params: z.object({
      appId: appIdSchema,
      username: usernameSchema,
      release: z.number().int().min(1),
      startCommand: appCommandSchema,
      memoryMb: appMemorySchema,
      healthPath: healthPathSchema,
      /** The journal stores by unit name, and app numbers are reused: only what came after this belongs to this app. */
      sinceMs: z.number().int().min(0),
    }).strict(),
    result: z.object({ healthy: z.boolean(), log: z.string() }),
  },
  "app.env": {
    params: z.object({ appId: appIdSchema, runtime: envVarsSchema, build: envVarsSchema }).strict(),
    result: ok,
  },
  "app.control": {
    params: z.object({ appId: appIdSchema, action: z.enum(["start", "stop", "restart"]) }).strict(),
    result: ok,
  },
  "app.status": {
    params: z.object({ appId: appIdSchema }).strict(),
    result: z.object({ state: z.string(), restarts: z.number(), memoryBytes: z.number().nullable(), sinceMs: z.number().nullable() }),
  },
  "app.logs": {
    params: z.object({ appId: appIdSchema, lines: logLinesSchema, sinceMs: z.number().int().min(0) }).strict(),
    result: z.object({ lines: z.array(z.string()) }),
  },
  "app.prune": {
    params: z.object({ appId: appIdSchema, username: usernameSchema, keep: z.array(z.number().int().min(1)) }).strict(),
    result: ok,
  },
  "app.remove": {
    params: z.object({ appId: appIdSchema, username: usernameSchema }).strict(),
    result: ok,
  },
  "ftp.setSuspended": {
    params: z.object({ username: usernameSchema, suspended: z.boolean() }).strict(),
    result: ok,
  },
  "db.setLocked": {
    params: z.object({ databases: z.array(dbFullNameSchema), locked: z.boolean() }).strict(),
    result: ok,
  },
  "php.restart": {
    params: z.object({ username: usernameSchema }).strict(),
    result: ok,
  },
  /**
   * MySQL's performance_schema (its internal statistics: queries, waits, memory). Off by default: it reserves a few
   * hundred MB that a hosting server does not use. `running` is what MySQL has now, `configured` what it starts with.
   */
  "mysql.diagnostics.get": {
    params: z.object({}).strict(),
    result: mysqlDiagnosticsSchema,
  },
  /** Writes the setting and restarts MySQL (a few seconds without databases). */
  "mysql.diagnostics.set": {
    params: z.object({ enabled: z.boolean() }).strict(),
    result: mysqlDiagnosticsSchema,
  },
  /** Writes the memory settings and restarts the server; if it does not start with them, the previous ones go back. */
  "mysql.tuning.set": {
    params: z.object({ tuning: dbTuningSchema }).strict(),
    result: mysqlDiagnosticsSchema,
  },
  ...backupOps,
  ...dbAdminOps,
  ...packageOps,
  ...wordpressOps,
  ...mailOps,
  /** File manager. Runs as the account user; the result depends on `request.op`. */
  "files.run": {
    params: z.object({ username: usernameSchema, request: fileRequestSchema }).strict(),
    result: z.unknown(),
  },
  "logs.read": {
    params: z.object({ username: usernameSchema, site: vhostSlugSchema, source: logSourceSchema, lines: logLinesSchema }).strict(),
    result: z.object({ lines: z.array(z.string()) }),
  },
  "system.publicIp": {
    params: z.object({}).strict(),
    result: z.object({ ip: z.string().nullable(), ip6: z.string().nullable().default(null) }),
  },
  "ftp.setPassword": {
    params: z.object({ username: usernameSchema, password: generatedSecretSchema }).strict(),
    result: ok,
  },
  /** FTP access of a single environment: it only sees `sites/<slug>`. */
  "ftp.setSitePassword": {
    params: z.object({ username: usernameSchema, site: vhostSlugSchema, password: generatedSecretSchema }).strict(),
    result: ok,
  },
  "ftp.removeSite": {
    params: z.object({ username: usernameSchema, site: vhostSlugSchema }).strict(),
    result: ok,
  },
  "db.create": {
    params: z.object({ username: usernameSchema, name: dbNameSchema, password: generatedSecretSchema }).strict(),
    result: ok,
  },
  "db.delete": {
    params: z.object({ username: usernameSchema, name: dbNameSchema }).strict(),
    result: ok,
  },
  "db.setPassword": {
    params: z.object({ username: usernameSchema, name: dbNameSchema, password: generatedSecretSchema }).strict(),
    result: ok,
  },
  "db.optimize": {
    params: z.object({ username: usernameSchema, name: dbNameSchema }).strict(),
    result: ok,
  },
  "db.setWritable": {
    params: z.object({ databases: z.array(dbFullNameSchema), writable: z.boolean() }).strict(),
    result: ok,
  },
  "db.usage": {
    params: z.object({}).strict(),
    result: z.object({
      databases: z.array(z.object({ name: z.string(), bytes: z.number() })),
      /** `null` if it could not be measured: it must never be taken as a full disk. */
      diskFreeBytes: z.number().nullable(),
    }),
  },
  "service.set": {
    params: z.object({
      username: usernameSchema,
      service: accountServiceSchema,
      enabled: z.boolean(),
      memoryMb: serviceMemorySchema,
    }).strict(),
    result: ok,
  },
  "site.remove": {
    params: z.object({ site: vhostSlugSchema }).strict(),
    result: ok,
  },
  /**
   * A new slug: moves `~/sites/<from>`, its OLS logs and its FTP login (with the same password). The configuration is
   * written again afterwards with `site.write` and `ols.sync`.
   */
  "site.rename": {
    params: z.object({ username: usernameSchema, from: vhostSlugSchema, to: vhostSlugSchema }).strict(),
    result: ok,
  },
  "ols.sync": {
    params: z.object({
      sites: z.array(z.object({
        site: vhostSlugSchema,
        username: usernameSchema,
        /** What the listeners map to this vhost. */
        hostname: fqdnSchema,
        certZone: fqdnSchema.nullable(),
        originPull: z.boolean(),
        /** Other names it serves as is. `secure`: its certificate covers it, so it is also mapped on 443. */
        aliases: z.array(z.object({ fqdn: fqdnSchema, secure: z.boolean() }).strict()).default([]),
      }).strict()),
      /**
       * One vhost per domain with names that redirect, without PHP or logs: each name answers a 301 to `target`.
       * Its certificate is the one of that domain, if it covers the name; a suspended account answers 503.
       */
      redirects: z.array(z.object({
        domain: fqdnSchema,
        certZone: fqdnSchema.nullable(),
        originPull: z.boolean(),
        suspended: z.boolean(),
        hosts: z.array(z.object({ fqdn: fqdnSchema, secure: z.boolean(), target: redirectTargetSchema }).strict()).min(1),
      }).strict()).default([]),
      /** Restarts even if nothing changed: OLS does not reread a vhost.conf modified on its own. */
      restart: z.boolean().optional(),
      /** Server-wide webhook domain: publishes only GLOBAL_HOOK_PATH to the panel. */
      hooks: z.object({ fqdn: fqdnSchema, certZone: fqdnSchema.nullable() }).strict().nullable().optional(),
      /** Mail names (`mail.<domain>`): on port 80 they only answer the ACME validation, proxied to MAIL_ACME_PORT. */
      acmeHosts: z.array(fqdnSchema).default([]),
      /** Mail domains with Roundcube at webmail.<domain>, each with the certificate of its domain. */
      webmail: z.array(z.object({ domain: fqdnSchema, certZone: fqdnSchema, originPull: z.boolean(), suspended: z.boolean() }).strict()).default([]),
    }).strict(),
    result: z.object({ changed: z.boolean() }),
  },
  "cert.write": {
    params: z.object({ zone: fqdnSchema, certPem: pemSchema, keyPem: pemSchema }).strict(),
    result: z.object({ names: z.array(z.string()), notAfter: z.number() }),
  },
  "cert.remove": {
    params: z.object({ zone: fqdnSchema }).strict(),
    result: ok,
  },
} as const;

export type AgentOpName = keyof typeof agentOps;
export type AgentOpParams<N extends AgentOpName> = z.infer<(typeof agentOps)[N]["params"]>;
export type AgentOpResult<N extends AgentOpName> = z.infer<(typeof agentOps)[N]["result"]>;

export const agentRequestSchema = z
  .object({ op: z.string().max(64), params: z.unknown() })
  .strict();

export type AgentErrorCode = "invalid_request" | "unknown_op" | "invalid_params" | "op_failed";

export type AgentResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: { code: AgentErrorCode; message: string } };

/** API types also used by the web UI. */
export type JobStatus = "pending" | "running" | "succeeded" | "rolled_back" | "rollback_failed" | "interrupted";
export type JobStepStatus = "pending" | "running" | "succeeded" | "failed" | "compensated" | "compensation_failed";

export interface JobStepDto {
  id: number;
  position: number;
  name: string;
  status: JobStepStatus;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface JobDto {
  id: string;
  type: string;
  title: string;
  status: JobStatus;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  steps: JobStepDto[];
}

export interface MeDto {
  username: string;
  totpEnabled: boolean;
}

export interface VhostDto {
  /** Never changes: the API and the panel URLs use it. */
  id: number;
  /** Unique on the server and editable: names its directory, its OLS vhost and its FTP login. */
  slug: string;
  name: string;
  /** The domain or subdomain it answers for (OLS also maps www. in front of it). */
  hostname: string;
  /** Root domain of its hostname, whose certificate it uses. */
  domain: string;
  type: VhostType;
  docRoot: string;
  phpVersion: string;
  phpOptions: PhpOptions;
  logLevel: LogLevel;
  logDays: number;
  /** Zone whose certificate covers this environment. Without it, Cloudflare in Full (strict) answers 526. */
  certZone: string | null;
  /** Other names of the account: an alias serves this environment, a redirect sends a 301 to its hostname. `secure`: covered by a certificate, also on 443. */
  extras: { fqdn: string; mode: HostnameMode; secure: boolean }[];
  app: AppDto | null;
  /** FTP access of this environment only. Without a password, it does not exist. Null for apps: they have no files to upload. */
  ftp: { login: string; root: string; passwordChangedAt: number | null } | null;
}

export type AppStatus = "new" | "deploying" | "online" | "stopped" | "failed";
export type DeploymentStatus = "running" | "succeeded" | "failed";

export interface AppDto {
  config: AppConfig;
  status: AppStatus;
  currentRelease: number | null;
  commit: string | null;
  /** Only if the repository uses SSH: it must be added to it as a read-only key. */
  deployKey: string | null;
  env: { key: string; value: string; scope: EnvScope }[];
  /**
   * Automatic deployment on every push to the branch. `secret` is the one entered in the GitHub webhook; without it,
   * the webhook is not active. The URLs are the ones that exist: the server-wide one and the account one.
   */
  webhook: { secret: string | null; urls: string[] };
  /** Requested deployments waiting for their turn, in order: the first one starts when the running one finishes. */
  queue: QueuedDeployDto[];
}

export interface QueuedDeployDto {
  id: number;
  trigger: string;
  commit: string | null;
  requestedAt: number;
}

/** `jobId` is null if it was queued behind another deployment; `position` is its place, 0 if it already started. */
export interface DeployRequestDto {
  jobId: string | null;
  position: number;
}

export interface DeploymentDto {
  id: number;
  release: number;
  commit: string | null;
  message: string | null;
  status: DeploymentStatus;
  startedAt: number;
  finishedAt: number | null;
  /** A copy exists on the server: it can be rolled back to without building. */
  available: boolean;
  active: boolean;
}

export interface DatabaseDto {
  /** Also the name of its MySQL user. */
  name: string;
  sizeBytes: number;
}

export interface AccountServiceDto {
  enabled: boolean;
  memoryMb: number;
  socket: string;
}

/** Socket path. Outside the home directory because FTP could delete it, and outside `/run/eaglepanel` because only the panel can enter there. */
export const serviceSocket = (service: AccountService, username: string) =>
  `/run/eaglepanel-services/${service}-${username}/${service}.sock`;

export interface CertificateDto {
  zone: string;
  names: string[];
  notAfter: number;
  /** The origin rejects every connection without the Cloudflare client certificate. */
  originPull: boolean;
}

/** Expiry of the global Authenticated Origin Pulls CA bundled with the agent. */
export const ORIGIN_PULL_CA_EXPIRES_AT = Date.UTC(2029, 10, 1, 17);

export interface HostnameDto {
  fqdn: string;
  /** Environment that answers for it: as its hostname (`main`), as an alias or with a redirect to it. */
  vhost: { id: number; name: string; slug: string; mode: HostnameMode | "main" } | null;
}

/** A root domain of the account, with its subdomains (the apex is the first hostname) and its certificate. */
export interface DomainDto {
  fqdn: string;
  hostnames: HostnameDto[];
  certificate: CertificateDto | null;
}

export interface AccountDto {
  username: string;
  limits: AccountLimits;
  /** Its sites answer 503, its services are stopped, and FTP and MySQL are blocked. Nothing is deleted. */
  suspended: boolean;
  createdAt: number;
  domains: DomainDto[];
  vhosts: VhostDto[];
  databases: DatabaseDto[];
  /** When the size limit is exceeded, or the server is low on disk, databases lose write privileges. */
  dbBlocked: boolean;
  ftpPasswordChangedAt: number | null;
  services: Record<AccountService, AccountServiceDto>;
  /** Account environment where its webhook URL is published. */
  hookVhost: number | null;
}

/** Server settings. */
/** Settings › database server: performance_schema (null: not answering), memory used now and its settings. */
export interface MysqlSettingsDto {
  /** `null` when the agent did not answer. */
  engine: "mysql" | "mariadb" | null;
  running: boolean | null;
  configured: boolean;
  memoryMb: number | null;
  /** RAM of the server, to size the buffer pool. */
  ramMb: number | null;
  tuning: DbTuning | null;
  tuningRunning: DbTuning | null;
}

export interface ServerSettingsDto {
  /** Server-wide webhook domain: one URL for every app on the server. */
  hooksDomain: string | null;
}

export interface PreflightDto {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export interface JobCreatedDto {
  jobId: string;
  /** Password generated for this job. Shown once and not stored anywhere. */
  secret?: string;
}

export interface AuditEntryDto {
  id: number;
  at: number;
  action: string;
  detail: string | null;
}

/* ---------- Server metrics and environment health (overview) ---------- */

export const METRICS_RANGES = ["1h", "24h", "7d"] as const;
export type MetricsRange = (typeof METRICS_RANGES)[number];

/** One point of the CPU and memory history, averaged over its interval. Percentages, 0 to 100. */
export interface MetricsPointDto {
  at: number;
  cpu: number;
  memory: number;
}

export interface SystemMetricsDto {
  range: MetricsRange;
  /** Width of each point. */
  intervalMs: number;
  points: MetricsPointDto[];
}

/**
 * `online`: OLS answers for the environment without a 5xx. `down`: it does not answer, answers 5xx, or the app failed.
 * `inactive`: an app that is stopped or was never deployed. `unknown`: not checked (sandbox, or before the first check).
 */
export type EnvironmentHealth = "online" | "down" | "inactive" | "suspended" | "deploying" | "unknown";

export interface EnvironmentHealthDto {
  id: number;
  name: string;
  health: EnvironmentHealth;
  /** HTTP status of the check, null if it did not answer or was not checked. */
  httpStatus: number | null;
  responseMs: number | null;
  checkedAt: number | null;
}

/* ---------- Update notifications ---------- */

export interface UpdateStatusDto {
  /** Installed version (the VERSION file of the package). Null in development. */
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  /** Release page, to read the notes and download the package. */
  releaseUrl: string | null;
  notes: string | null;
  publishedAt: number | null;
  checkedAt: number | null;
  /** Where it checks: null when no source is configured (no check is made). */
  source: "github" | "manifest" | null;
  /** Message of the last failed check; the last known result is kept. */
  error: string | null;
}
