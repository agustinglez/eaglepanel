import type { AccountService, AgentOpParams } from "@eaglepanel/shared";
import type { CommandResult, Host } from "./host";

// ---------------------------------------------------------------------------- FTP

export const FTP_DIR = "/etc/eaglepanel/ftp";
/** Source of the vsftpd database: user and SHA-512 hash on alternating lines, as `db_load -T` expects. */
export const FTP_USERS = `${FTP_DIR}/users.txt`;
const FTP_DB = `${FTP_DIR}/users.db`;
const FTP_ACTIVE = `${FTP_DIR}/users.active.txt`;
const FTP_SUSPENDED = `${FTP_DIR}/suspended.txt`;
export const ftpUserFile = (username: string) => `${FTP_DIR}/vusers/${username}`;

export function parseFtpUsers(content: string | null): Map<string, string> {
  const lines = (content ?? "").split("\n").filter(Boolean);
  const users = new Map<string, string>();
  for (let index = 0; index + 1 < lines.length; index += 2) users.set(lines[index]!, lines[index + 1]!);
  return users;
}

const renderFtpUsers = (users: [string, string][]) => users.map(([username, hash]) => `${username}\n${hash}\n`).join("");
const parseLines = (content: string | null) => new Set((content ?? "").split("\n").filter(Boolean));

/**
 * The database is built separately and replaced as a whole: vsftpd never sees a half-written one. A suspended account keeps its
 * hash in `users.txt`, to come back with the same password, but it is not in the database used for login.
 */
async function writeFtpUsers(host: Host, users: Map<string, string>): Promise<void> {
  await host.writeFileAtomic(FTP_USERS, renderFtpUsers([...users]), 0o600);
  const suspended = parseLines(await host.readFile(FTP_SUSPENDED));
  const active = [...users].filter(([username]) => !suspended.has(username));
  const next = `${FTP_DB}.new`;
  await check(host, "rm", ["-f", next]);
  if (active.length === 0) {
    await check(host, "rm", ["-f", FTP_DB]);
    return;
  }
  await host.writeFileAtomic(FTP_ACTIVE, renderFtpUsers(active), 0o600);
  await check(host, "db_load", ["-T", "-t", "hash", "-f", FTP_ACTIVE, next]);
  await check(host, "rm", ["-f", FTP_ACTIVE]);
  await check(host, "chmod", ["600", next]);
  await check(host, "mv", ["-f", next, FTP_DB]);
}

export async function setFtpSuspended(host: Host, username: string, suspended: boolean): Promise<void> {
  await check(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "700", FTP_DIR]);
  const list = parseLines(await host.readFile(FTP_SUSPENDED));
  if (suspended) list.add(username);
  else list.delete(username);
  await host.writeFileAtomic(FTP_SUSPENDED, [...list].map((name) => `${name}\n`).join(""), 0o600);
  await writeFtpUsers(host, parseFtpUsers(await host.readFile(FTP_USERS)));
  if (!suspended) return;
  // Removing it from the database only stops new logins. Measured on the VPS: an open session kept responding.
  const { code, stderr } = await host.run("pkill", ["-KILL", "-u", username, "-x", "vsftpd"]);
  if (code > 1) throw new Error(`Could not close the FTP sessions: ${stderr.trim().slice(0, 200)}`);
}

export async function setFtpPassword(host: Host, username: string, password: string): Promise<void> {
  const { stdout } = await check(host, "openssl", ["passwd", "-6", "-stdin"], password);
  const hash = host.sandbox ? "$6$sandbox" : stdout.trim();
  if (!hash.startsWith("$6$")) throw new Error("Could not generate the password hash");

  await check(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "700", FTP_DIR, `${FTP_DIR}/vusers`]);
  // The root is the home directory: vsftpd shares it between the virtual user and its real owner.
  await host.writeFileAtomic(ftpUserFile(username), `guest_username=${username}\nlocal_root=/home/${username}\n`, 0o600);
  const users = parseFtpUsers(await host.readFile(FTP_USERS));
  users.set(username, hash);
  await writeFtpUsers(host, users);
}

/** Migration: the same hash it had at the source, so the account keeps logging in with its password. */
export async function setFtpHash(host: Host, username: string, hash: string): Promise<void> {
  await check(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "700", FTP_DIR, `${FTP_DIR}/vusers`]);
  await host.writeFileAtomic(ftpUserFile(username), `guest_username=${username}\nlocal_root=/home/${username}\n`, 0o600);
  const users = parseFtpUsers(await host.readFile(FTP_USERS));
  users.set(username, hash);
  await writeFtpUsers(host, users);
}

export async function removeFtpUser(host: Host, username: string): Promise<void> {
  const suspended = parseLines(await host.readFile(FTP_SUSPENDED));
  if (suspended.delete(username)) await host.writeFileAtomic(FTP_SUSPENDED, [...suspended].map((name) => `${name}\n`).join(""), 0o600);
  const users = parseFtpUsers(await host.readFile(FTP_USERS));
  if (users.delete(username)) await writeFtpUsers(host, users);
  await check(host, "rm", ["-f", "--", ftpUserFile(username)]);
}

// ---------------------------------------------------------------------------- MySQL

/** What an account over the limit keeps: it can read and free space, but not grow. */
const BLOCKED_PRIVILEGES = "SELECT, DELETE, DROP, SHOW VIEW, LOCK TABLES";
const MAX_USER_CONNECTIONS = 20;

/** Names are already validated, and the `_` in the GRANT is escaped so it does not act as a wildcard. */
const grantTarget = (database: string) => `\`${database.replaceAll("_", "\\_")}\`.*`;
const mysqlUser = (database: string) => `'${database}'@'localhost'`;

/**
 * `-N -B` gives one row per line, without headers. The SQL goes through stdin: on the command line it would show in `ps`.
 * With `hideError`, MySQL could quote the failed SQL, and that SQL contains a password.
 */
async function mysql(host: Host, sql: string, { hideError = false } = {}): Promise<string> {
  const result = await host.run("mysql", ["--protocol=socket", "-uroot", "-N", "-B"], { stdin: sql });
  if (result.code !== 0) {
    throw new Error(hideError ? `MySQL rejected the operation (code ${result.code})` : `MySQL failed: ${result.stderr.trim().slice(0, 300)}`);
  }
  return result.stdout;
}

/** After revoking or dropping, MySQL lets open connections continue: tested on the VPS. */
async function killConnections(host: Host, databases: string[]): Promise<void> {
  if (databases.length === 0) return;
  const users = databases.map((database) => `'${database}'`).join(",");
  const output = await mysql(host, `SELECT ID FROM information_schema.PROCESSLIST WHERE USER IN (${users});`);
  for (const id of output.split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line))) {
    // It may have ended between the two queries.
    await host.run("mysql", ["--protocol=socket", "-uroot", "-N", "-B"], { stdin: `KILL ${id};` });
  }
}

export async function createDatabase(host: Host, { username, name, password }: AgentOpParams<"db.create">): Promise<void> {
  const database = `${username}_${name}`;
  await mysql(host, [
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`,
    `CREATE USER IF NOT EXISTS ${mysqlUser(database)} IDENTIFIED BY '${password}' WITH MAX_USER_CONNECTIONS ${MAX_USER_CONNECTIONS};`,
    `ALTER USER ${mysqlUser(database)} IDENTIFIED BY '${password}';`,
    `GRANT ALL ON ${grantTarget(database)} TO ${mysqlUser(database)};`,
  ].join("\n"), { hideError: true });
}

/**
 * Recreates a deleted database and its user with the password hash it had, taken from a backup manifest:
 * the app that uses it reconnects without changing anything. The agent builds the SQL; only the hash is taken from
 * the backup, already validated as hexadecimal.
 */
export async function recreateDatabase(host: Host, database: string, authHash: string): Promise<void> {
  await mysql(host, [
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`,
    `CREATE USER IF NOT EXISTS ${mysqlUser(database)} IDENTIFIED WITH caching_sha2_password AS ${authHash} WITH MAX_USER_CONNECTIONS ${MAX_USER_CONNECTIONS};`,
    `GRANT ALL ON ${grantTarget(database)} TO ${mysqlUser(database)};`,
  ].join("\n"), { hideError: true });
}

export async function deleteDatabase(host: Host, database: string): Promise<void> {
  await mysql(host, `DROP USER IF EXISTS ${mysqlUser(database)};`);
  await killConnections(host, [database]);
  await mysql(host, `DROP DATABASE IF EXISTS \`${database}\`;`);
}

export async function setDatabasePassword(host: Host, database: string, password: string): Promise<void> {
  await mysql(host, `ALTER USER ${mysqlUser(database)} IDENTIFIED BY '${password}';`, { hideError: true });
}

export async function setDatabasesWritable(host: Host, databases: string[], writable: boolean): Promise<void> {
  if (databases.length === 0) return;
  const privileges = writable ? "ALL" : BLOCKED_PRIVILEGES;
  await mysql(host, databases.map((database) => [
    `REVOKE ALL PRIVILEGES ON ${grantTarget(database)} FROM ${mysqlUser(database)};`,
    `GRANT ${privileges} ON ${grantTarget(database)} TO ${mysqlUser(database)};`,
  ].join("\n")).join("\n"));
  if (!writable) await killConnections(host, databases);
}

/** Touches neither privileges nor the password: when unblocked, everything stays the same. Tested on the VPS. */
export async function setDatabasesLocked(host: Host, databases: string[], locked: boolean): Promise<void> {
  if (databases.length === 0) return;
  await mysql(host, databases.map((database) => `ALTER USER ${mysqlUser(database)} ACCOUNT ${locked ? "LOCK" : "UNLOCK"};`).join("\n"));
  // The block only stops new connections: the one that was open stayed alive on the VPS.
  if (locked) await killConnections(host, databases);
}

/** Runs as root: an account blocked by the limit has no privilege, and it is exactly the one that needs it. */
export async function optimizeDatabase(host: Host, database: string): Promise<void> {
  const output = await mysql(host, `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${database}' AND TABLE_TYPE = 'BASE TABLE';`);
  const tables = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (tables.length === 0) return;
  // The table name was chosen by the account: backticks are doubled so it cannot close the identifier.
  const list = tables.map((table) => `\`${database}\`.\`${table.replaceAll("`", "``")}\``).join(", ");
  await mysql(host, `OPTIMIZE TABLE ${list};`);
}

export async function databaseUsage(host: Host): Promise<{ databases: { name: string; bytes: number }[]; diskFreeBytes: number | null }> {
  const output = await mysql(host, "SELECT SUBSTRING_INDEX(NAME, '/', 1), SUM(ALLOCATED_SIZE) FROM information_schema.INNODB_TABLESPACES WHERE NAME LIKE '%/%' GROUP BY 1;");
  const databases = output.split("\n").flatMap((line) => {
    const [name, bytes] = line.split("\t");
    return name && bytes && /^\d+$/.test(bytes) ? [{ name, bytes: Number(bytes) }] : [];
  });
  const disk = await host.run("df", ["-B1", "--output=avail", "/var/lib/mysql"]);
  const free = disk.stdout.split("\n")[1]?.trim() ?? "";
  return { databases, diskFreeBytes: disk.code === 0 && /^\d+$/.test(free) ? Number(free) : null };
}

// ---------------------------------------------------------------------------- Redis and Memcached

const SERVICES: AccountService[] = ["redis", "memcached"];
const unitName = (service: AccountService, username: string) => `eaglepanel-${service}@${username}`;
const dropInDir = (service: AccountService, username: string) => `/etc/systemd/system/${unitName(service, username)}.service.d`;
export const dropInPath = (service: AccountService, username: string) => `${dropInDir(service, username)}/limits.conf`;

/** The process cap leaves headroom over the service cap: Redis uses memory beyond the data. */
const renderLimits = (memoryMb: number) => `[Service]
Environment=SERVICE_MEMORY_MB=${memoryMb}
MemoryMax=${memoryMb * 2}M
`;

export async function configureService(host: Host, { username, service, enabled, memoryMb }: AgentOpParams<"service.set">): Promise<void> {
  await host.writeFileAtomic(dropInPath(service, username), renderLimits(memoryMb), 0o644);
  await check(host, "systemctl", ["daemon-reload"]);
  const unit = unitName(service, username);
  if (enabled) {
    await check(host, "systemctl", ["enable", unit]);
    // Without a restart, an active service would keep the previous memory.
    await check(host, "systemctl", ["restart", unit]);
  } else {
    await check(host, "systemctl", ["disable", "--now", unit]);
  }
}

export async function removeServices(host: Host, username: string): Promise<void> {
  for (const service of SERVICES) {
    // Fails if it was never enabled: it does not matter, what follows cleans up anyway.
    await host.run("systemctl", ["disable", "--now", unitName(service, username)]);
    await check(host, "rm", ["-rf", "--", dropInDir(service, username)]);
  }
  await check(host, "systemctl", ["daemon-reload"]);
}

// ----------------------------------------------------------------------------

async function check(host: Host, command: string, args: string[], stdin?: string): Promise<CommandResult> {
  const result = await host.run(command, args, stdin === undefined ? {} : { stdin });
  if (result.code !== 0) throw new Error(`${command} failed (code ${result.code}): ${result.stderr.trim().slice(0, 300)}`);
  return result;
}
