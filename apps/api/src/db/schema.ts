import { DEFAULT_LOG_DAYS, DEFAULT_LOG_LEVEL, DEFAULT_PHP_OPTIONS, DEFAULT_SERVICE_MEMORY_MB, type AppKind, type AppRuntime, type AppStatus, type DeploymentStatus, type EnvScope, type JobStatus, type JobStepStatus, type LogLevel, type PhpOptions, type VhostType } from "@eaglepanel/shared";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const admin = sqliteTable("admin", {
  id: integer("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  totpSecret: text("totp_secret"),
  totpEnabled: integer("totp_enabled", { mode: "boolean" }).notNull().default(false),
  /** Last accepted TOTP period: prevents reusing the same code. */
  totpLastCounter: integer("totp_last_counter"),
  updatedAt: integer("updated_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  /** SHA-256 of the token: a copy of the database does not allow using active sessions. */
  tokenHash: text("token_hash").primaryKey(),
  adminId: integer("admin_id").notNull().references(() => admin.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const accounts = sqliteTable("accounts", {
  username: text("username").primaryKey(),
  quotaMb: integer("quota_mb").notNull(),
  maxDomains: integer("max_domains").notNull().default(1),
  /** Excluding the primary environment of each domain. */
  maxVhosts: integer("max_vhosts").notNull().default(10),
  maxDatabases: integer("max_databases").notNull().default(5),
  dbStorageMb: integer("db_storage_mb").notNull().default(1024),
  appMemoryMb: integer("app_memory_mb").notNull().default(512),
  suspended: integer("suspended", { mode: "boolean" }).notNull().default(false),
  dbBlocked: integer("db_blocked", { mode: "boolean" }).notNull().default(false),
  ftpPasswordChangedAt: integer("ftp_password_changed_at"),
  redisEnabled: integer("redis_enabled", { mode: "boolean" }).notNull().default(false),
  redisMemoryMb: integer("redis_memory_mb").notNull().default(DEFAULT_SERVICE_MEMORY_MB),
  memcachedEnabled: integer("memcached_enabled", { mode: "boolean" }).notNull().default(false),
  memcachedMemoryMb: integer("memcached_memory_mb").notNull().default(DEFAULT_SERVICE_MEMORY_MB),
  /** Account environment where its webhook URL is published. Cleared when that environment is deleted. */
  hookDomain: text("hook_domain"),
  createdAt: integer("created_at").notNull(),
});

/** Server settings, one per key. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** The password is not stored: only MySQL knows it, and it is shown once when generated. */
export const databases = sqliteTable("databases", {
  name: text("name").primaryKey(),
  username: text("username").notNull().references(() => accounts.username, { onDelete: "cascade" }),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("databases_username").on(table.username)]);

export const domains = sqliteTable("domains", {
  fqdn: text("fqdn").primaryKey(),
  username: text("username").notNull().references(() => accounts.username, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("domains_username").on(table.username)]);

/** Called "environments" in the interface. */
export const vhosts = sqliteTable("vhosts", {
  fqdn: text("fqdn").primaryKey(),
  username: text("username").notNull().references(() => accounts.username, { onDelete: "cascade" }),
  domain: text("domain").notNull().references(() => domains.fqdn, { onDelete: "cascade" }),
  isMain: integer("is_main", { mode: "boolean" }).notNull(),
  type: text("type").$type<VhostType>().notNull(),
  /** Relative to the account home directory. */
  docRoot: text("doc_root").notNull(),
  phpVersion: text("php_version").notNull(),
  phpOptions: text("php_options", { mode: "json" }).$type<PhpOptions>().notNull().default(DEFAULT_PHP_OPTIONS),
  logLevel: text("log_level").$type<LogLevel>().notNull().default(DEFAULT_LOG_LEVEL),
  logDays: integer("log_days").notNull().default(DEFAULT_LOG_DAYS),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("vhosts_username").on(table.username), index("vhosts_domain").on(table.domain)]);

export const certificates = sqliteTable("certificates", {
  zone: text("zone").primaryKey(),
  username: text("username").notNull().references(() => accounts.username, { onDelete: "cascade" }),
  names: text("names", { mode: "json" }).$type<string[]>().notNull(),
  notAfter: integer("not_after").notNull(),
  /** Enabled separately: requiring it with the Cloudflare switch off leaves the domain without service. */
  originPull: integer("origin_pull", { mode: "boolean" }).notNull().default(false),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  status: text("status").$type<JobStatus>().notNull(),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
}, (table) => [index("jobs_created_at").on(table.createdAt)]);

export const jobSteps = sqliteTable("job_steps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  name: text("name").notNull(),
  status: text("status").$type<JobStepStatus>().notNull(),
  error: text("error"),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
}, (table) => [unique("job_steps_position").on(table.jobId, table.position)]);

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  action: text("action").notNull(),
  detail: text("detail"),
}, (table) => [index("audit_log_at").on(table.at)]);

/** An app-type environment. `id` defines its namespace and private address: it is not reused while it exists. */
export const apps = sqliteTable("apps", {
  fqdn: text("fqdn").primaryKey().references(() => vhosts.fqdn, { onDelete: "cascade" }),
  id: integer("id").notNull().unique(),
  repoUrl: text("repo_url").notNull(),
  branch: text("branch").notNull(),
  subdir: text("subdir").notNull().default(""),
  runtime: text("runtime").$type<AppRuntime>().notNull(),
  runtimeVersion: text("runtime_version").notNull(),
  /** `static` is served by OLS without any process; `server` runs in its container. */
  kind: text("kind").$type<AppKind>().notNull().default("server"),
  buildCommand: text("build_command").notNull(),
  startCommand: text("start_command").notNull(),
  outputDir: text("output_dir").notNull().default(""),
  spaFallback: integer("spa_fallback", { mode: "boolean" }).notNull().default(true),
  healthPath: text("health_path").notNull(),
  memoryMb: integer("memory_mb").notNull(),
  status: text("status").$type<AppStatus>().notNull(),
  currentRelease: integer("current_release"),
  commit: text("commit"),
  deployKey: text("deploy_key"),
  /** GitHub webhook secret, to verify the signature of each push. Without it, the webhook does not deploy. */
  webhookSecret: text("webhook_secret"),
  createdAt: integer("created_at").notNull(),
});

/** Values are stored here so they can be edited: only the panel user can read the database. */
export const appEnv = sqliteTable("app_env", {
  fqdn: text("fqdn").notNull().references(() => apps.fqdn, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull(),
  scope: text("scope").$type<EnvScope>().notNull(),
}, (table) => [primaryKey({ columns: [table.fqdn, table.key] })]);

export const deployments = sqliteTable("deployments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fqdn: text("fqdn").notNull().references(() => apps.fqdn, { onDelete: "cascade" }),
  release: integer("release").notNull(),
  /** A release of one type does not work for the other: output directory or image. */
  kind: text("kind").$type<AppKind>().notNull().default("server"),
  commit: text("commit"),
  message: text("message"),
  status: text("status").$type<DeploymentStatus>().notNull(),
  log: text("log").notNull().default(""),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
}, (table) => [index("deployments_fqdn").on(table.fqdn)]);

/**
 * Requested deployments waiting for the previous one of the same app to finish, in order. It lives in the database, not
 * in memory: if the panel restarts, the queue resumes at startup.
 */
export const deployQueue = sqliteTable("deploy_queue", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fqdn: text("fqdn").notNull().references(() => apps.fqdn, { onDelete: "cascade" }),
  /** Who requested it: the panel or the webhook, with the branch and the commit. */
  trigger: text("trigger").notNull(),
  /** The push commit. Without it, the branch tip at start time is deployed. */
  commit: text("commit"),
  requestedAt: integer("requested_at").notNull(),
}, (table) => [index("deploy_queue_fqdn").on(table.fqdn)]);

/** Downloadable copies of an account. The file lives on the server until it expires. */
export const accountExports = sqliteTable("account_exports", {
  id: text("id").primaryKey(),
  username: text("username").notNull().references(() => accounts.username, { onDelete: "cascade" }),
  status: text("status").$type<"running" | "ready" | "failed">().notNull(),
  sizeBytes: integer("size_bytes"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
