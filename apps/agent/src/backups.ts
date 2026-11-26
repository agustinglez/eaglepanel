import {
  BACKUP_RETENTION,
  backupManifestSchema,
  type AgentOpParams,
  type AgentOpResult,
  type BackupSnapshot,
  type ResticRepo,
  type ServerSecrets,
} from "@eaglepanel/shared";
import { KEYS } from "./apps";
import { workerCommand } from "./files-runner";
import { collationFix, dbClient, dbEngine, defaultCollation, dumpCommand } from "./db-engine";
import type { Host } from "./host";
import { certPath, keyPath } from "./ols";
import { FTP_USERS, parseFtpUsers } from "./services";

/**
 * Backups with restic. Runs as root to read every home directory in full, but what goes back to an account (its
 * restored files) is written by a process running as the account user: a backup cannot be used to write outside
 * its home directory. Passwords and keys travel only through environment variables of the restic process, which
 * no account can read thanks to `hidepid`.
 */

/** Fixed, not the hostname: if the server is renamed, backups stay grouped the same way. */
export const RESTIC_HOST = "eaglepanel";
const CACHE_DIR = "/var/cache/eaglepanel/restic";
const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** A large backup can take a while; a hung one must not block the others forever. */
const TIMEOUT_MS = 6 * 60 * 60 * 1000;

export const manifestPath = (username: string) => `/eaglepanel/${username}/manifest.json`;
export const databasePath = (username: string, database: string) => `/eaglepanel/${username}/databases/${database}.sql`;
export const homePath = (username: string) => `/home/${username}`;

/**
 * What is not worth saving: it regenerates on its own. `.build` is the app build cache (Bun packages and the like)
 * and `node_modules` gets reinstalled; with thousands of small files, they slow backups down. `data/`, the
 * persistent app data, is saved.
 */
export const homeExcludes = (username: string) => ["--exclude", `${homePath(username)}/.build`, "--exclude", "node_modules"];

export function resticEnv(repo: ResticRepo): Record<string, string> {
  return {
    PATH: BASE_PATH,
    HOME: "/root",
    LC_ALL: "C",
    RESTIC_REPOSITORY: repo.repository,
    RESTIC_PASSWORD: repo.password,
    RESTIC_CACHE_DIR: CACHE_DIR,
    // Without this, restic tries to read root's AWS configuration, if there is one.
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    ...(repo.accessKeyId ? { AWS_ACCESS_KEY_ID: repo.accessKeyId } : {}),
    ...(repo.secretAccessKey ? { AWS_SECRET_ACCESS_KEY: repo.secretAccessKey } : {}),
    ...(repo.region ? { AWS_DEFAULT_REGION: repo.region } : {}),
  };
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function exec(cmd: string[], env: Record<string, string>, stdin?: string): Promise<Result> {
  const proc = Bun.spawn(cmd, { env, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** `producer | [filter |] consumer` without a shell. Fails if any of them fails. */
async function pipe(
  producer: { cmd: string[]; env: Record<string, string> },
  consumer: { cmd: string[]; env: Record<string, string>; cwd?: string },
  filter?: { cmd: string[]; env: Record<string, string> },
): Promise<void> {
  const first = Bun.spawn(producer.cmd, { env: producer.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const middle = filter ? Bun.spawn(filter.cmd, { env: filter.env, stdin: first.stdout, stdout: "pipe", stderr: "pipe" }) : null;
  const second = Bun.spawn(consumer.cmd, { env: consumer.env, cwd: consumer.cwd, stdin: middle ? middle.stdout : first.stdout, stdout: "pipe", stderr: "pipe" });
  const [firstErr, firstCode, middleErr, middleCode, secondErr, secondCode] = await Promise.all([
    new Response(first.stderr).text(), first.exited,
    middle ? new Response(middle.stderr).text() : Promise.resolve(""), middle ? middle.exited : Promise.resolve(0),
    new Response(second.stderr).text(), second.exited,
  ]);
  if (firstCode !== 0) throw new Error(`${producer.cmd[0]} failed: ${tail(firstErr)}`);
  if (middleCode !== 0) throw new Error(`${filter!.cmd[0]} failed: ${tail(middleErr)}`);
  if (secondCode !== 0) throw new Error(`${consumer.cmd.includes("tar") ? "tar" : consumer.cmd[0]} failed: ${tail(secondErr)}`);
}

const tail = (text: string) => text.trim().split("\n").slice(-3).join(" ").slice(0, 400) || "no details";

async function restic(repo: ResticRepo, args: string[], stdin?: string): Promise<Result> {
  const binary = Bun.which("restic", { PATH: BASE_PATH });
  if (!binary) throw new Error("restic is missing on the server");
  return exec([binary, ...args], resticEnv(repo), stdin);
}

async function resticOk(repo: ResticRepo, args: string[], stdin?: string): Promise<string> {
  const result = await restic(repo, args, stdin);
  if (result.code !== 0) throw new Error(`restic failed: ${tail(result.stderr)}`);
  return result.stdout;
}

// ---------------------------------------------------------------------------- Repository

/** Creates the repository if it does not exist. If it exists with another password, it fails: it is not overwritten. */
export async function initRepository(repo: ResticRepo): Promise<{ created: boolean }> {
  const probe = await restic(repo, ["cat", "config"]);
  if (probe.code === 0) return { created: false };
  // restic exits with 10 when the repository does not exist; with 12, when the password does not match.
  if (probe.code === 12) throw new Error("The repository already exists and the password does not match");
  if (probe.code !== 10) throw new Error(`Could not access the repository: ${tail(probe.stderr)}`);
  await resticOk(repo, ["init"]);
  return { created: true };
}

// ---------------------------------------------------------------------------- Backup

/** What the server stores for the account outside the panel database. */
export async function serverSecrets(host: Host, { username, databases, zones, appIds }: { username: string; databases: string[]; zones: string[]; appIds: number[] }): Promise<ServerSecrets> {
  const certificates: ServerSecrets["certificates"] = [];
  for (const zone of zones) {
    const [cert, key] = await Promise.all([host.readFile(certPath(zone)), host.readFile(keyPath(zone))]);
    if (cert && key) certificates.push({ zone, cert, key });
  }
  const ftpHash = parseFtpUsers(await host.readFile(FTP_USERS)).get(username) ?? null;
  const mysqlUsers: ServerSecrets["mysqlUsers"] = [];
  for (const database of databases) {
    // MySQL, in hexadecimal: the caching_sha2_password hash has bytes that do not survive as text. MariaDB's is text
    // already, and it has no such setting.
    const user = `'${database}'@'localhost'`;
    const hex = dbEngine() === "mysql" ? "SET SESSION print_identified_with_as_hex = ON;\n" : "";
    const result = await host.run(dbClient(), ["--protocol=socket", "-uroot", "-N", "-B", "-r"], {
      stdin: `${hex}SHOW CREATE USER ${user};\nSHOW GRANTS FOR ${user};\n`,
    });
    if (result.code !== 0) continue;
    const [createUser, ...grants] = result.stdout.split("\n").filter(Boolean);
    if (createUser) mysqlUsers.push({ database, createUser, grants });
  }
  const deployKeys: ServerSecrets["deployKeys"] = [];
  for (const appId of appIds) {
    const [privateKey, publicKey] = await Promise.all([host.readFile(`${KEYS}/${appId}`), host.readFile(`${KEYS}/${appId}.pub`)]);
    if (privateKey && publicKey) deployKeys.push({ appId, privateKey, publicKey });
  }
  return { certificates, ftpHash, mysqlUsers, deployKeys };
}

interface BackupSummary {
  message_type?: string;
  snapshot_id?: string;
  data_added?: number;
}

/** The summary is the last JSON line of `restic backup --json`. */
function summaryOf(stdout: string): BackupSummary {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line) as BackupSummary;
      if (parsed.message_type === "summary") return parsed;
    } catch { /* progress line */ }
  }
  return {};
}

const tags = (username: string, run: string, part: string, extra: string[] = []) =>
  ["--host", RESTIC_HOST, "--tag", `acct:${username}`, "--tag", `run:${run}`, "--tag", `part:${part}`, ...extra.flatMap((tag) => ["--tag", tag])];

export async function backupAccount(host: Host, params: AgentOpParams<"backup.account">): Promise<AgentOpResult<"backup.account">> {
  const { repo, username, run, databases } = params;
  const snapshots: { part: string; id: string; bytesAdded: number }[] = [];
  const record = async (part: string, args: string[], stdin?: string) => {
    const result = await restic(repo, ["backup", "--json", ...args], stdin);
    // 3: some files could not be read, but the snapshot exists. Reported as a failure so it gets reviewed.
    if (result.code !== 0) throw new Error(`${part}: restic failed (code ${result.code}): ${tail(result.stderr)}`);
    const summary = summaryOf(result.stdout);
    snapshots.push({ part, id: summary.snapshot_id ?? "", bytesAdded: summary.data_added ?? 0 });
  };

  // The manifest first: it allows recreating the account even if another part fails.
  const manifest = backupManifestSchema.parse({
    version: 1,
    username,
    createdAt: Date.now(),
    panel: JSON.parse(params.panel) as Record<string, unknown>,
    server: await serverSecrets(host, params),
  });
  await record("manifest", [...tags(username, run, "manifest"), "--stdin", "--stdin-filename", manifestPath(username)], JSON.stringify(manifest));

  // Links are stored as links; --one-file-system does not enter mounts inside the home directory.
  await record("files", [...tags(username, run, "files"), "--one-file-system", "--exclude-caches", ...homeExcludes(username), homePath(username)]);

  for (const database of databases) {
    // Without --databases: the dump does not name the database, so it can be loaded into the same one or another.
    await record(`database:${database}`, [
      ...tags(username, run, "database", [`db:${database}`]),
      "--stdin-filename", databasePath(username, database),
      "--stdin-from-command", "--",
      ...dumpCommand(), database,
    ]);
  }
  return { snapshots };
}

/** Retention per account and per part: each home, each database and each manifest is a group. */
export async function forgetOld(repo: ResticRepo): Promise<void> {
  await resticOk(repo, [
    "forget", "--host", RESTIC_HOST, "--group-by", "host,paths",
    "--keep-daily", String(BACKUP_RETENTION.daily), "--keep-weekly", String(BACKUP_RETENTION.weekly), "--prune",
  ]);
}

/** Every snapshot of the account, from every run, and the space they free up. */
export async function purgeAccount(repo: ResticRepo, username: string, before: number): Promise<{ removed: number }> {
  const ids = (await listSnapshots(repo, username)).filter(({ time }) => time < before).map(({ id }) => id);
  if (ids.length === 0) return { removed: 0 };
  await resticOk(repo, ["forget", "--prune", ...ids]);
  return { removed: ids.length };
}

// ---------------------------------------------------------------------------- Query

interface ResticSnapshot {
  id: string;
  time: string;
  tags?: string[];
  paths?: string[];
  summary?: { total_bytes_processed?: number };
}

const tagValue = (tagList: string[] | undefined, key: string) => tagList?.find((tag) => tag.startsWith(`${key}:`))?.slice(key.length + 1) ?? null;

export function toSnapshot(raw: ResticSnapshot): BackupSnapshot | null {
  const username = tagValue(raw.tags, "acct");
  const run = tagValue(raw.tags, "run");
  const part = tagValue(raw.tags, "part");
  if (!username || !run || (part !== "files" && part !== "database" && part !== "manifest")) return null;
  return {
    id: raw.id,
    time: Date.parse(raw.time),
    username,
    run,
    part,
    database: tagValue(raw.tags, "db"),
    sizeBytes: raw.summary?.total_bytes_processed ?? null,
  };
}

export async function listSnapshots(repo: ResticRepo, username?: string): Promise<BackupSnapshot[]> {
  const stdout = await resticOk(repo, ["snapshots", "--json", "--host", RESTIC_HOST, ...(username ? ["--tag", `acct:${username}`] : [])]);
  const raw = JSON.parse(stdout || "[]") as ResticSnapshot[];
  return raw.map(toSnapshot).filter((item): item is BackupSnapshot => item !== null).sort((a, b) => b.time - a.time);
}

/** The snapshot must belong to that account and that part: a foreign id cannot be used to restore into another account. */
async function snapshotFor(repo: ResticRepo, id: string, username: string | null, part: string): Promise<BackupSnapshot> {
  const stdout = await resticOk(repo, ["snapshots", "--json", "--host", RESTIC_HOST, id]);
  const found = (JSON.parse(stdout || "[]") as ResticSnapshot[]).map(toSnapshot).find((item) => item !== null);
  if (!found || found.part !== part || (username !== null && found.username !== username)) throw new Error("That backup does not belong to this account or does not contain that part");
  return found;
}

// ---------------------------------------------------------------------------- Restore

export async function readManifest(repo: ResticRepo, snapshot: string) {
  const found = await snapshotFor(repo, snapshot, null, "manifest");
  const stdout = await resticOk(repo, ["dump", found.id, manifestPath(found.username)]);
  return backupManifestSchema.parse(JSON.parse(stdout));
}

const asUser = (username: string, cmd: string[]) => ["setpriv", `--reuid=${username}`, `--regid=${username}`, "--clear-groups", "--no-new-privs", "--", ...cmd];
const userEnv = (username: string) => ({ PATH: "/usr/bin:/bin", HOME: homePath(username), LC_ALL: "C.UTF-8" });

function stamp(time: number): string {
  return new Date(time).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

/**
 * Restores a directory or a file from the home directory. `inplace` writes over what is there (anything not in the
 * backup stays); `folder` puts it in `restored-<date>/`, touching nothing. It is always written by the account, not root.
 */
export async function restoreFiles(repo: ResticRepo, { username, snapshot, path, mode }: AgentOpParams<"backup.restoreFiles">): Promise<{ restoredTo: string }> {
  const found = await snapshotFor(repo, snapshot, username, "files");
  const home = homePath(username);
  const source = path ? `${home}/${path}` : home;
  const base = mode === "folder" ? `restored-${stamp(found.time)}` : "";
  const destRel = [base, path].filter(Boolean).join("/");

  const listing = await resticOk(repo, ["ls", "--json", found.id, source]);
  const node = listing.split("\n").map((line) => { try { return JSON.parse(line) as { struct_type?: string; path?: string; type?: string }; } catch { return null; } })
    .find((item) => item?.struct_type === "node" && item.path === source);
  if (!node) throw new Error(`Not in that backup: ${path || "home"}`);

  const env = resticEnv(repo);
  const resticBin = Bun.which("restic", { PATH: BASE_PATH }) ?? "restic";
  if (node.type === "file") {
    // A single file: saved by the account file process, with an atomic write.
    if (mode === "folder") await mkdirAsUser(username, destRel.slice(0, destRel.lastIndexOf("/")));
    const { cmd, env: workerEnv, cwd } = workerCommand(username, ["upload", destRel, "1"]);
    await pipe({ cmd: [resticBin, "dump", found.id, source], env }, { cmd, env: workerEnv, cwd });
  } else if (node.type === "dir") {
    await mkdirAsUser(username, destRel);
    // `id:directory` puts the content at the root of the tar. tar runs as the account: it cannot write outside what it owns.
    await pipe(
      { cmd: [resticBin, "dump", "--archive", "tar", `${found.id}:${source}`, "/"], env },
      { cmd: asUser(username, ["tar", "-x", "-p", "-f", "-", "-C", destRel ? `${home}/${destRel}` : home, "--no-same-owner"]), env: userEnv(username), cwd: home },
    );
  } else {
    throw new Error("Only directories and files are restored");
  }
  return { restoredTo: destRel };
}

async function mkdirAsUser(username: string, rel: string): Promise<void> {
  if (!rel) return;
  const result = await exec(asUser(username, ["mkdir", "-p", "--", `${homePath(username)}/${rel}`]), userEnv(username));
  if (result.code !== 0) throw new Error(`Could not create ${rel}: ${tail(result.stderr)}`);
}

/**
 * Replaces the database with the one in the backup: it is emptied and the dump is loaded. The MySQL user privileges are
 * on the database name and survive. `--one-database` ignores any statement aimed at another database.
 */
export async function restoreDatabase(host: Host, repo: ResticRepo, { username, snapshot, database }: AgentOpParams<"backup.restoreDatabase">): Promise<void> {
  if (!database.startsWith(`${username}_`)) throw new Error("The database does not belong to this account");
  const found = await snapshotFor(repo, snapshot, username, "database");
  if (found.database !== database) throw new Error("That backup belongs to another database");
  const reset = await host.run(dbClient(), ["--protocol=socket", "-uroot", "-N", "-B"], {
    stdin: `DROP DATABASE IF EXISTS \`${database}\`;\nCREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE ${defaultCollation()};\n`,
  });
  if (reset.code !== 0) throw new Error(`MySQL failed: ${tail(reset.stderr)}`);
  const resticBin = Bun.which("restic", { PATH: BASE_PATH }) ?? "restic";
  const toolEnv = { PATH: BASE_PATH, HOME: "/root", LC_ALL: "C" };
  const fix = collationFix();
  await pipe(
    { cmd: [resticBin, "dump", found.id, databasePath(username, database)], env: resticEnv(repo) },
    { cmd: [dbClient(), "--protocol=socket", "-uroot", "--one-database", "--default-character-set=utf8mb4", database], env: toolEnv },
    // A copy made on MySQL loaded into MariaDB (a migration): its collations are translated on the way.
    fix.length > 0 ? { cmd: ["sed", "-E", ...fix], env: toolEnv } : undefined,
  );
}
