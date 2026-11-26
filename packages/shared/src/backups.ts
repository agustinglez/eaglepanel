import { z } from "zod";
import { filePathSchema } from "./files";
import { dbFullNameSchema, fqdnSchema, usernameSchema } from "./validators";

/**
 * Backups with restic on S3 storage (AWS, Cloudflare R2 or another compatible service). One repository per server;
 * in it, for every account and every backup: the home directory, one dump per database and a manifest with what is needed to recreate it.
 */

/** Fixed retention for now: per account and per part. */
export const BACKUP_RETENTION = { daily: 7, weekly: 4 } as const;

/** Origin only: `https://<account>.r2.cloudflarestorage.com` or `https://s3.us-east-1.amazonaws.com`. */
export const s3EndpointSchema = z.string().max(200).regex(/^https:\/\/[a-z0-9.-]+(?::\d{2,5})?$/, "Must be https://host, without a path");
/** S3 bucket naming rules, which R2 also follows. */
export const bucketSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "Invalid bucket name");
export const bucketPrefixSchema = z.string().max(200).regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "Invalid prefix: letters, digits, . _ - and /");
const credential = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/, "Invalid credential");

/** What is entered in Settings. The secret never goes back to the browser: empty on save means "do not change". */
export const backupSettingsSchema = z.object({
  enabled: z.boolean(),
  endpoint: s3EndpointSchema,
  bucket: bucketSchema,
  prefix: bucketPrefixSchema,
  region: z.string().regex(/^[a-z0-9-]{2,32}$/, "Invalid region"),
  accessKeyId: credential,
  secretAccessKey: z.union([z.literal(""), credential]),
  /** Server time at which the daily backup runs. */
  hour: z.number().int().min(0).max(23),
}).strict();
export type BackupSettings = z.infer<typeof backupSettingsSchema>;

export interface BackupSettingsDto {
  configured: boolean;
  enabled: boolean;
  endpoint: string;
  bucket: string;
  prefix: string;
  region: string;
  accessKeyId: string;
  hasSecret: boolean;
  hour: number;
  /** Shown only when the repository is created: without it no backup can be read. */
  repositoryPassword?: string;
  lastRun: { at: number; ok: boolean; detail: string } | null;
  /** Deleted accounts whose backups could not be deleted yet. */
  pendingPurges: string[];
}

/** What the agent needs to talk to the repository. The API builds it from the settings. */
export const resticRepoSchema = z.object({
  /** `s3:https://host/bucket/prefix`, or an absolute directory (tests only). */
  repository: z.string().max(500).refine((value) => /^s3:https:\/\/[a-z0-9.-]+(?::\d{2,5})?\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](\/[A-Za-z0-9._-]+)*$/.test(value) || /^\/[A-Za-z0-9._/-]+$/.test(value), "Invalid repository"),
  password: z.string().min(16).max(256),
  accessKeyId: z.string().max(256).optional(),
  secretAccessKey: z.string().max(256).optional(),
  region: z.string().max(32).optional(),
}).strict();
export type ResticRepo = z.infer<typeof resticRepoSchema>;

export const snapshotIdSchema = z.string().regex(/^[0-9a-f]{8,64}$/, "Invalid backup");
/** Identifies a backup: every part of an account in that run shares this value. */
export const backupRunIdSchema = z.string().regex(/^\d{8}T\d{6}Z(-[a-z0-9]{1,8})?$/, "Invalid backup");

export const backupPartSchema = z.enum(["files", "database", "manifest"]);
export type BackupPart = z.infer<typeof backupPartSchema>;

export const backupSnapshotSchema = z.object({
  id: z.string(),
  time: z.number(),
  username: z.string(),
  run: z.string(),
  part: backupPartSchema,
  /** Database parts only. */
  database: z.string().nullable(),
  sizeBytes: z.number().nullable(),
});
export type BackupSnapshot = z.infer<typeof backupSnapshotSchema>;

/** What the server stores outside the panel database. Goes inside the manifest, encrypted by restic. */
export const serverSecretsSchema = z.object({
  certificates: z.array(z.object({ zone: z.string(), cert: z.string(), key: z.string() })),
  ftpHash: z.string().nullable(),
  mysqlUsers: z.array(z.object({ database: z.string(), createUser: z.string(), grants: z.array(z.string()) })),
  deployKeys: z.array(z.object({ appId: z.number(), privateKey: z.string(), publicKey: z.string() })),
});
export type ServerSecrets = z.infer<typeof serverSecretsSchema>;

export const backupManifestSchema = z.object({
  version: z.literal(1),
  username: z.string(),
  createdAt: z.number(),
  /** Rows of the panel database for this account, as they were. */
  panel: z.record(z.string(), z.unknown()),
  server: serverSecretsSchema,
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/**
 * The password hash of a database user. MySQL: caching_sha2_password in hexadecimal, as `SHOW CREATE USER` returns it
 * with print_identified_with_as_hex. MariaDB: mysql_native_password, `*` and 40 hexadecimal digits.
 */
export const mysqlAuthHashSchema = z.string().regex(/^(0x[0-9A-F]{40,400}|\*[0-9A-F]{40})$/, "Invalid hash");

/** Extracts the hash from the stored `CREATE USER`. `null` if it is not in the expected format: nothing else from that statement is used. */
export function authHashOf(createUser: string): string | null {
  const match = /IDENTIFIED WITH 'caching_sha2_password' AS (0x[0-9A-F]+)/.exec(createUser) ?? /IDENTIFIED BY PASSWORD '(\*[0-9A-F]{40})'/.exec(createUser);
  return match && mysqlAuthHashSchema.safeParse(match[1]).success ? match[1]! : null;
}

/** SHA-512 crypt, like the one `openssl passwd -6` generates. */
export const ftpHashSchema = z.string().regex(/^\$6\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}$/, "Invalid FTP hash");
export const deployPrivateKeySchema = z.string().max(8192).regex(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END OPENSSH PRIVATE KEY-----\n?$/, "Invalid key");
export const deployPublicKeySchema = z.string().max(1024).regex(/^ssh-ed25519 [A-Za-z0-9+/=]+( [A-Za-z0-9._@-]+)?\n?$/, "Invalid key");

export const exportIdSchema = z.string().regex(/^[0-9a-f]{32}$/, "Invalid copy");

/** How long a downloadable copy stays available before it is deleted. */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

export interface AccountExportDto {
  id: string;
  createdAt: number;
  expiresAt: number;
  sizeBytes: number | null;
  status: "running" | "ready" | "failed";
}

export const restoreModeSchema = z.enum(["inplace", "folder"]);

/** Agent operations; added by `agentOps`. */
export const backupOps = {
  "backup.init": {
    params: z.object({ repo: resticRepoSchema }).strict(),
    result: z.object({ created: z.boolean() }),
  },
  "backup.account": {
    params: z.object({
      repo: resticRepoSchema,
      username: usernameSchema,
      run: backupRunIdSchema,
      /** The panel part of the manifest, as JSON. The agent adds the server secrets. */
      panel: z.string().max(4 * 1024 * 1024),
      databases: z.array(dbFullNameSchema),
      zones: z.array(fqdnSchema),
      appIds: z.array(z.number().int().min(1).max(16383)),
    }).strict(),
    result: z.object({ snapshots: z.array(z.object({ part: z.string(), id: z.string(), bytesAdded: z.number() })) }),
  },
  "backup.forget": {
    params: z.object({ repo: resticRepoSchema }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Deletes every backup of an account: used when deleting it. */
  "backup.purge": {
    /** Only those before `before`: if another account is created with the same name, its backups are untouched. */
    params: z.object({ repo: resticRepoSchema, username: usernameSchema, before: z.number().int().min(0) }).strict(),
    result: z.object({ removed: z.number() }),
  },
  "backup.snapshots": {
    params: z.object({ repo: resticRepoSchema, username: usernameSchema.optional() }).strict(),
    result: z.object({ snapshots: z.array(backupSnapshotSchema) }),
  },
  "backup.restoreFiles": {
    params: z.object({ repo: resticRepoSchema, username: usernameSchema, snapshot: snapshotIdSchema, path: filePathSchema, mode: restoreModeSchema }).strict(),
    result: z.object({ restoredTo: z.string() }),
  },
  "backup.restoreDatabase": {
    params: z.object({ repo: resticRepoSchema, username: usernameSchema, snapshot: snapshotIdSchema, database: dbFullNameSchema }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Downloadable copy of the account: home and dumps, with nothing from the panel. */
  "export.create": {
    params: z.object({ username: usernameSchema, id: exportIdSchema, databases: z.array(dbFullNameSchema) }).strict(),
    result: z.object({ sizeBytes: z.number() }),
  },
  "export.delete": {
    params: z.object({ id: exportIdSchema }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Migration: whether a Linux user with that name already exists, and whether it belongs to the panel. */
  "migrate.userCheck": {
    params: z.object({ username: usernameSchema }).strict(),
    result: z.object({ exists: z.boolean(), managed: z.boolean() }),
  },
  /** Migration: the FTP account with the same password hash it had on the source server. */
  "migrate.ftpHash": {
    params: z.object({ username: usernameSchema, hash: ftpHashSchema }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Migration: the app deploy key, so the repository keeps accepting it without adding it to GitHub again. */
  "migrate.deployKey": {
    params: z.object({ appId: z.number().int().min(1).max(16383), privateKey: deployPrivateKeySchema, publicKey: deployPublicKeySchema }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Recreates a deleted database and its user with the same password, before loading the dump into it. */
  "backup.recreateDatabase": {
    params: z.object({ username: usernameSchema, database: dbFullNameSchema, authHash: mysqlAuthHashSchema }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "backup.manifest": {
    params: z.object({ repo: resticRepoSchema, snapshot: snapshotIdSchema }).strict(),
    result: z.object({ manifest: backupManifestSchema }),
  },
};

/** One row per account backup: its parts grouped by run. */
export interface BackupRunDto {
  run: string;
  time: number;
  files: string | null;
  manifest: string | null;
  databases: { name: string; snapshot: string }[];
  sizeBytes: number | null;
}

/** What a backup contains, without values or secrets, to choose what to restore. */
export interface BackupManifestSummaryDto {
  /** `id` is the current environment, if it still exists. */
  vhosts: { id: number | null; name: string; type: "php" | "app"; exists: boolean; sameType: boolean; envKeys: string[]; app: boolean }[];
  databases: { name: string; exists: boolean; hasUser: boolean }[];
}

/** An account in another server's repository, with its backups. */
export interface MigrationAccountDto {
  username: string;
  /** An account with that name already exists here: it cannot be imported. */
  exists: boolean;
  runs: { run: string; time: number; complete: boolean }[];
}
