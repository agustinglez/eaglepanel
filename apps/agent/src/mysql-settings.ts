import { totalmem } from "node:os";
import type { AgentOpParams, AgentOpResult, DbTuning } from "@eaglepanel/shared";
import { dbClient, dbEngine, type DbEngine } from "./db-engine";
import type { Host } from "./host";

/**
 * performance_schema has a file of its own, apart from the installer's eaglepanel.cnf: the installer writes it only
 * when it is missing (off), and from then on it is what the panel set. Read after eaglepanel.cnf (alphabetical order).
 * MariaDB reads /etc/mysql/conf.d too, and is restarted through its mysql.service alias.
 */
export const DIAGNOSTICS_CNF = "/etc/mysql/conf.d/eaglepanel-diagnostics.cnf";
/** The memory settings, the same way: written by the installer only when missing, then the panel's. */
export const TUNING_CNF = "/etc/mysql/conf.d/eaglepanel-tuning.cnf";

export const renderDiagnosticsCnf = (enabled: boolean) => `# Managed by EaglePanel (Settings › MySQL). Do not edit by hand.
[mysqld]
performance_schema = ${enabled ? "ON" : "OFF"}
`;

/** MariaDB has no X plugin: `mysqlx` would stop it from starting. */
export const renderTuningCnf = (tuning: DbTuning, engine: DbEngine) => `# Managed by EaglePanel (Settings). Do not edit by hand.
[mysqld]
innodb_buffer_pool_size = ${tuning.bufferPoolMb}M
innodb_log_buffer_size = ${tuning.logBufferMb}M
max_connections = ${tuning.maxConnections}
table_open_cache = ${tuning.tableOpenCache}
table_definition_cache = ${tuning.tableDefinitionCache}
${engine === "mysql" ? `mysqlx = ${tuning.xProtocol ? "ON" : "OFF"}\n` : ""}`;

/** What the file says. Without the file MySQL uses its default, which is on. */
export function configuredOf(content: string | null): boolean {
  const value = /^\s*performance[_-]schema\s*=\s*(\S+)/im.exec(content ?? "")?.[1]?.toLowerCase();
  return value === undefined ? true : ["on", "1", "true"].includes(value);
}

/** The settings in the file, or `null` without it (or if someone left it incomplete): the server's own defaults apply. */
export function tuningOf(content: string | null, engine: DbEngine): DbTuning | null {
  if (content === null) return null;
  const value = (name: string) => new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, "im").exec(content)?.[1];
  const mb = (name: string) => {
    const match = /^(\d+)([KMG]?)$/i.exec(value(name) ?? "");
    if (!match) return null;
    const factor = { "": 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 }[match[2]!.toUpperCase() as "" | "K" | "M" | "G"];
    return Math.round(Number(match[1]) * factor);
  };
  const int = (name: string) => {
    const raw = value(name) ?? "";
    return /^\d+$/.test(raw) ? Number(raw) : null;
  };
  const tuning = {
    bufferPoolMb: mb("innodb_buffer_pool_size"),
    logBufferMb: mb("innodb_log_buffer_size"),
    maxConnections: int("max_connections"),
    tableOpenCache: int("table_open_cache"),
    tableDefinitionCache: int("table_definition_cache"),
  };
  if (Object.values(tuning).some((item) => item === null)) return null;
  // Without the line, MySQL loads the X plugin.
  return { ...(tuning as Omit<DbTuning, "xProtocol">), xProtocol: engine === "mysql" && value("mysqlx")?.toUpperCase() !== "OFF" };
}

async function query(host: Host, sql: string): Promise<string | null> {
  const result = await host.run(dbClient(), ["--protocol=socket", "-uroot", "-N", "-B", "-e", sql]);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** What the running server has, read in one query. */
async function runningTuning(host: Host, engine: DbEngine): Promise<DbTuning | null> {
  const row = await query(host, "SELECT @@innodb_buffer_pool_size, @@innodb_log_buffer_size, @@max_connections, @@table_open_cache, @@table_definition_cache");
  const values = row?.split("\t").map(Number) ?? [];
  if (values.length !== 5 || values.some((value) => !Number.isFinite(value))) return null;
  const x = engine === "mysql" ? await query(host, "SELECT PLUGIN_STATUS FROM information_schema.PLUGINS WHERE PLUGIN_NAME = 'mysqlx'") : null;
  const [pool, log, connections, open, definitions] = values as [number, number, number, number, number];
  return {
    bufferPoolMb: Math.round(pool / 1048576),
    logBufferMb: Math.round(log / 1048576),
    maxConnections: connections,
    tableOpenCache: open,
    tableDefinitionCache: definitions,
    xProtocol: x === "ACTIVE",
  };
}

async function state(host: Host): Promise<AgentOpResult<"mysql.diagnostics.get">> {
  const engine = dbEngine();
  const configured = configuredOf(await host.readFile(DIAGNOSTICS_CNF));
  const performance = await query(host, "SELECT @@performance_schema");
  const running = performance === null ? null : performance === "1";
  // MariaDB's server process is mariadbd.
  const ps = await host.run("ps", ["-C", "mysqld,mariadbd", "-o", "rss="]);
  const kb = ps.stdout.split("\n").map((line) => Number(line.trim())).filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  return {
    engine,
    running,
    configured,
    memoryMb: kb > 0 ? Math.round(kb / 1024) : null,
    ramMb: Math.round(totalmem() / 1048576),
    tuning: tuningOf(await host.readFile(TUNING_CNF), engine),
    tuningRunning: running === null ? null : await runningTuning(host, engine),
  };
}

/**
 * Writes one of the panel's files and restarts the server. If it does not come back with the new file, the previous
 * one goes back, so the sites keep their databases.
 */
async function apply(host: Host, path: string, content: string): Promise<void> {
  const previous = await host.readFile(path);
  await host.writeFileAtomic(path, content, 0o644);
  const restart = await host.run("systemctl", ["restart", "mysql"]);
  if (restart.code === 0) return;
  if (previous === null) await host.run("rm", ["-f", path]);
  else await host.writeFileAtomic(path, previous, 0o644);
  await host.run("systemctl", ["restart", "mysql"]);
  throw new Error(`MySQL did not start with that setting and the previous one was restored: ${restart.stderr.trim().slice(0, 200)}`);
}

const sandboxState = (enabled: boolean, tuning: DbTuning | null = null): AgentOpResult<"mysql.diagnostics.get"> => ({
  engine: dbEngine(),
  running: enabled,
  configured: enabled,
  memoryMb: enabled ? 520 : 300,
  ramMb: 4096,
  tuning,
  tuningRunning: tuning,
});

export const mysqlSettingsHandlers = {
  "mysql.diagnostics.get": async (_params: AgentOpParams<"mysql.diagnostics.get">, host: Host) => {
    if (host.sandbox) return sandboxState(false);
    return state(host);
  },

  "mysql.diagnostics.set": async ({ enabled }: AgentOpParams<"mysql.diagnostics.set">, host: Host) => {
    if (host.sandbox) return sandboxState(enabled);
    await apply(host, DIAGNOSTICS_CNF, renderDiagnosticsCnf(enabled));
    const result = await state(host);
    if (result.running !== enabled) throw new Error(`MySQL restarted but performance_schema is ${result.running ? "on" : "off"}: another configuration file sets it`);
    return result;
  },

  "mysql.tuning.set": async ({ tuning }: AgentOpParams<"mysql.tuning.set">, host: Host) => {
    if (host.sandbox) return sandboxState(false, tuning);
    await apply(host, TUNING_CNF, renderTuningCnf(tuning, dbEngine()));
    return state(host);
  },
};
