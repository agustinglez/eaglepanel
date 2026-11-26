/**
 * Database explorer: tables, structure and rows of an account database, plus export and import of dumps.
 *
 * Browsing runs as root through Bun.SQL, but never with SQL written by the browser: values always go as parameters,
 * and table or column names are only used after finding them in information_schema (and quoted anyway).
 *
 * Importing runs the uploaded dump as a temporary MySQL user with privileges on that database only, never as root:
 * a statement aimed at another database, at mysql.user or with DEFINER=root is rejected by MySQL itself. Before
 * loading, the database is copied; if anything fails, it is put back as it was.
 */
import { SQL } from "bun";
import { lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_CELL_CHARS,
  MAX_FULL_CELL_CHARS,
  MAX_RESULT_ROWS,
  MAX_UPLOAD_BYTES,
  STATEMENT_TIMEOUT_SECONDS,
  ROW_STATEMENTS,
  firstKeyword,
  hasSeveralStatements,
  type DbAccess,
  type DbProcessDto,
  type ExecuteRequest,
  type ExecuteResultDto,
  type DbRowsDto,
  type DbStructureDto,
  type DbTableDto,
  type RowQuery,
} from "@eaglepanel/shared";
import { collationFix, dbClient, dbEngine, defaultCollation, dumpCommand } from "./db-engine";
import { SandboxHost, type Host } from "./host";

const MYSQL_SOCKET = "/run/mysqld/mysqld.sock";
const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const TOOL_ENV = { PATH: BASE_PATH, HOME: "/root", LC_ALL: "C" };
/**
 * Uploaded dumps waiting to be imported, and the copy taken before each import. Root only, and outside
 * /var/lib/eaglepanel: that one belongs to the panel user, which could swap a subdirectory for a link and make the
 * agent write as root somewhere else.
 */
export const IMPORT_DIR = "/var/lib/eaglepanel-db-imports";
/** An upload nobody imported is deleted after this. */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** Up to this estimate, the rows of a table are counted exactly. */
const EXACT_COUNT_LIMIT = 50_000;
const QUERY_TIMEOUT_MS = 15_000;
const COUNT_TIMEOUT_MS = 5_000;
const BINARY_PREVIEW_BYTES = 32;

// ---------------------------------------------------------------------------- SQL access

export interface SqlClient {
  /** One statement, with `?` placeholders for values. Each query starts with a marker comment, used by the fakes. */
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** A single connection as root through the socket (auth_socket): every query of an operation goes through it. */
export async function rootSql(database?: string): Promise<SqlClient> {
  const sql = new SQL({ adapter: "mysql", path: MYSQL_SOCKET, username: "root", database, max: 1, idleTimeout: 30 });
  // Without this, MySQL's information_schema returns sizes and row counts cached for up to a day. MariaDB reads them
  // fresh and has no such setting.
  if (dbEngine() === "mysql") await sql.unsafe("SET SESSION information_schema_stats_expiry = 0");
  return {
    query: async (text, params = []) => [...(await sql.unsafe(text, params))] as Record<string, unknown>[],
    close: () => sql.close(),
  };
}

export const quoteName = (name: string) => `\`${name.replaceAll("`", "``")}\``;
/** In a GRANT, `_` is a wildcard: it is escaped so it matches only this database. */
const grantTarget = (database: string) => `${quoteName(database.replaceAll("_", "\\_"))}.*`;

const text = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value);
};
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : text(value));
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : null;
};

// ---------------------------------------------------------------------------- Browse

export async function databaseExists(sql: SqlClient, database: string): Promise<boolean> {
  const rows = await sql.query("/* ep:schema */ SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [database]);
  return rows.length > 0;
}

export async function listTables(sql: SqlClient, database: string): Promise<DbTableDto[]> {
  const rows = await sql.query(
    "/* ep:tables */ SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS row_count, DATA_LENGTH AS data_bytes, " +
      "INDEX_LENGTH AS index_bytes, TABLE_COLLATION AS collation_name, TABLE_COMMENT AS comment FROM information_schema.TABLES " +
      "WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
    [database],
  );
  return rows.map((row) => {
    const view = text(row.type) === "VIEW";
    return {
      name: text(row.name),
      kind: view ? "view" : "table",
      engine: textOrNull(row.engine),
      rows: view ? null : num(row.row_count),
      dataBytes: num(row.data_bytes) ?? 0,
      indexBytes: num(row.index_bytes) ?? 0,
      collation: textOrNull(row.collation_name),
      comment: view ? "" : text(row.comment),
    };
  });
}

interface ColumnInfo {
  name: string;
  type: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  key: string;
  extra: string;
  comment: string;
}

/** The table as MySQL knows it. Throws if it does not exist: no name reaches SQL without going through here. */
async function findTable(sql: SqlClient, database: string, table: string): Promise<{ name: string; kind: "table" | "view"; estimate: number | null }> {
  const rows = await sql.query(
    "/* ep:table */ SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS row_count FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [database, table],
  );
  const row = rows[0];
  // The comparison is case-insensitive on some setups: the name is taken as MySQL returns it.
  if (!row || text(row.name) !== table) throw new Error("Table not found");
  const view = text(row.type) === "VIEW";
  return { name: table, kind: view ? "view" : "table", estimate: view ? null : num(row.row_count) };
}

async function tableColumns(sql: SqlClient, database: string, table: string): Promise<ColumnInfo[]> {
  const rows = await sql.query(
    "/* ep:columns */ SELECT COLUMN_NAME AS name, COLUMN_TYPE AS column_type, DATA_TYPE AS data_type, IS_NULLABLE AS nullable, " +
      "COLUMN_DEFAULT AS default_value, COLUMN_KEY AS column_key, EXTRA AS extra, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS " +
      "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    [database, table],
  );
  return rows.map((row) => ({
    name: text(row.name),
    type: text(row.column_type),
    dataType: text(row.data_type).toLowerCase(),
    nullable: text(row.nullable) === "YES",
    default: textOrNull(row.default_value),
    key: text(row.column_key),
    extra: text(row.extra),
    comment: text(row.comment),
  }));
}

export async function describeTable(sql: SqlClient, database: string, table: string): Promise<DbStructureDto> {
  const found = await findTable(sql, database, table);
  const columns = await tableColumns(sql, database, table);
  const indexRows = found.kind === "view" ? [] : await sql.query(
    "/* ep:indexes */ SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, INDEX_TYPE AS index_type, COLUMN_NAME AS column_name, EXPRESSION AS expression " +
      "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX",
    [database, table],
  );
  const indexes = new Map<string, DbStructureDto["indexes"][number]>();
  for (const row of indexRows) {
    const name = text(row.name);
    const index = indexes.get(name) ?? { name, unique: num(row.non_unique) === 0, type: text(row.index_type), columns: [] };
    // A functional index has no column: its expression is shown instead.
    index.columns.push(textOrNull(row.column_name) ?? `(${text(row.expression)})`);
    indexes.set(name, index);
  }
  const create = await sql.query(`/* ep:create */ SHOW CREATE ${found.kind === "view" ? "VIEW" : "TABLE"} ${quoteName(database)}.${quoteName(found.name)}`);
  const createRow = create[0] ?? {};
  return {
    kind: found.kind,
    columns: columns.map(({ dataType: _dataType, ...column }) => column),
    indexes: [...indexes.values()],
    createSql: text(createRow["Create Table"] ?? createRow["Create View"]),
  };
}

const BINARY_TYPES = new Set(["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"]);
const SPATIAL_TYPES = new Set(["geometry", "point", "linestring", "polygon", "multipoint", "multilinestring", "multipolygon", "geometrycollection", "geomcollection"]);

/** What the grid shows of each column: always text, cut to MAX_CELL_CHARS; binary data as a hexadecimal preview. */
export function cellExpression(column: { name: string; dataType: string }): string {
  const ref = quoteName(column.name);
  if (BINARY_TYPES.has(column.dataType)) {
    return `IF(${ref} IS NULL, NULL, CONCAT('0x', HEX(SUBSTRING(${ref}, 1, ${BINARY_PREVIEW_BYTES})), ` +
      `IF(LENGTH(${ref}) > ${BINARY_PREVIEW_BYTES}, CONCAT('... (', LENGTH(${ref}), ' bytes)'), '')))`;
  }
  const asText = column.dataType === "bit"
    ? `CAST(${ref} + 0 AS CHAR)`
    : SPATIAL_TYPES.has(column.dataType)
      ? `ST_AsText(${ref})`
      : `CAST(${ref} AS CHAR CHARACTER SET utf8mb4)`;
  return `IF(CHAR_LENGTH(${asText}) > ${MAX_CELL_CHARS}, CONCAT(LEFT(${asText}, ${MAX_CELL_CHARS}), '…'), ${asText})`;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** The WHERE of the filter, with its value as a parameter. The column must be one of the table's. */
export function filterClause(columns: { name: string }[], query: Pick<RowQuery, "column" | "op" | "value">): { sql: string; params: unknown[] } {
  if (!query.column || !query.op) return { sql: "", params: [] };
  if (!columns.some((column) => column.name === query.column)) throw new Error("Unknown column");
  const ref = quoteName(query.column);
  const value = query.value ?? "";
  switch (query.op) {
    case "null": return { sql: ` WHERE ${ref} IS NULL`, params: [] };
    case "notnull": return { sql: ` WHERE ${ref} IS NOT NULL`, params: [] };
    case "eq": return { sql: ` WHERE ${ref} = ?`, params: [value] };
    case "ne": return { sql: ` WHERE ${ref} <> ?`, params: [value] };
    case "gt": return { sql: ` WHERE ${ref} > ?`, params: [value] };
    case "lt": return { sql: ` WHERE ${ref} < ?`, params: [value] };
    case "contains": return { sql: ` WHERE ${ref} LIKE ?`, params: [`%${escapeLike(value)}%`] };
    case "starts": return { sql: ` WHERE ${ref} LIKE ?`, params: [`${escapeLike(value)}%`] };
  }
}

/** Builds the page query. Exported for the tests: they check that nothing from the browser ends up in the SQL text. */
export function buildRowsQuery(database: string, table: string, columns: ColumnInfo[], query: RowQuery): { sql: string; params: unknown[]; where: { sql: string; params: unknown[] } } {
  if (columns.length === 0) throw new Error("The table has no columns");
  const where = filterClause(columns, query);
  let order = "";
  if (query.sort) {
    if (!columns.some((column) => column.name === query.sort)) throw new Error("Unknown column");
    order = ` ORDER BY ${quoteName(query.sort)} ${query.dir === "desc" ? "DESC" : "ASC"}`;
  } else {
    // Without an order, MySQL may repeat or skip rows between pages: the primary key keeps them stable.
    const primary = columns.filter((column) => column.key === "PRI");
    if (primary.length > 0) order = ` ORDER BY ${primary.map((column) => quoteName(column.name)).join(", ")}`;
  }
  const select = columns.map((column, index) => `${cellExpression(column)} AS c${index}`).join(", ");
  const offset = (query.page - 1) * query.size;
  return {
    // Integers already validated: LIMIT goes inline, MySQL does not accept every parameter type there.
    sql: `/* ep:rows */ SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */ ${select} FROM ${quoteName(database)}.${quoteName(table)}${where.sql}${order} LIMIT ${query.size} OFFSET ${offset}`,
    params: where.params,
    where,
  };
}

export async function readRows(sql: SqlClient, database: string, table: string, query: RowQuery): Promise<DbRowsDto> {
  const found = await findTable(sql, database, table);
  const columns = await tableColumns(sql, database, table);
  const built = buildRowsQuery(database, found.name, columns, query);
  const rows = await sql.query(built.sql, built.params);

  let total: number | null = null;
  let exact = true;
  if (!built.where.sql && found.estimate !== null && found.estimate > EXACT_COUNT_LIMIT) {
    total = found.estimate;
    exact = false;
  } else {
    try {
      const counted = await sql.query(
        `/* ep:count */ SELECT /*+ MAX_EXECUTION_TIME(${COUNT_TIMEOUT_MS}) */ COUNT(*) AS n FROM ${quoteName(database)}.${quoteName(found.name)}${built.where.sql}`,
        built.where.params,
      );
      total = num(counted[0]?.n);
    } catch {
      // Too slow: the page is shown anyway, without a total.
      total = null;
    }
  }
  return {
    columns: columns.map((column) => ({ name: column.name, type: column.type })),
    rows: rows.map((row) => columns.map((_, index) => textOrNull(row[`c${index}`]))),
    total,
    exact,
  };
}

// ---------------------------------------------------------------------------- Export

const dumpArgs = (database: string, structureOnly: boolean) => [...dumpCommand(), ...(structureOnly ? ["--no-data"] : []), database];

/** mysqldump compressed on the fly. The download starts at once; a large database is never held in memory. */
export function exportStream(database: string, structureOnly: boolean): ReadableStream<Uint8Array> {
  const dump = Bun.spawn(dumpArgs(database, structureOnly), { env: TOOL_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const gzip = Bun.spawn(["gzip", "-c", "-6"], { env: TOOL_ENV, stdin: dump.stdout, stdout: "pipe", stderr: "ignore" });
  void Promise.all([new Response(dump.stderr).text(), dump.exited]).then(([stderr, code]) => {
    if (code !== 0) console.error(`[agent] mysqldump ${database} failed (code ${code}): ${stderr.trim().slice(0, 300)}`);
  });
  return gzip.stdout;
}

/** In sandbox mode there is no MySQL: a small dump, enough to test the download. */
export function sandboxExport(database: string, structureOnly: boolean): ReadableStream<Uint8Array> {
  const sql = `-- EaglePanel sandbox dump of ${database}\nCREATE TABLE \`demo\` (\`id\` int NOT NULL, PRIMARY KEY (\`id\`));\n${structureOnly ? "" : "INSERT INTO `demo` VALUES (1),(2);\n"}`;
  return new Blob([Bun.gzipSync(new TextEncoder().encode(sql))]).stream();
}

// ---------------------------------------------------------------------------- Uploads

function importDir(host: Host): string {
  return host instanceof SandboxHost ? host.resolvePath(IMPORT_DIR) : IMPORT_DIR;
}

const GZIP_MAGIC = [0x1f, 0x8b];

/** Stores the dump to import. It accepts plain SQL or gzip; anything else is rejected before touching the database. */
export async function storeUpload(host: Host, body: ReadableStream<Uint8Array>): Promise<{ id: string; bytes: number }> {
  const dir = importDir(host);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!host.sandbox) {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o077) !== 0) throw new Error(`${IMPORT_DIR} must be a directory of root with mode 700`);
  }
  await cleanOldUploads(dir);
  const id = crypto.randomUUID().replaceAll("-", "");
  const path = join(dir, id);
  const writer = Bun.file(path).writer();
  let bytes = 0;
  let head: Uint8Array | null = null;
  try {
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_UPLOAD_BYTES) throw new Error("The file exceeds the maximum");
      if (!head) head = chunk.slice(0, 4096);
      writer.write(chunk);
    }
    await writer.end();
    if (bytes === 0 || !head) throw new Error("The file is empty");
    const gzip = head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
    // A SQL dump is text: a NUL byte at the start means some other file (a zip, an image...).
    if (!gzip && head.includes(0)) throw new Error("It is not a SQL file (.sql or .sql.gz)");
    return { id, bytes };
  } catch (error) {
    try {
      await writer.end();
    } catch { /* already closed */ }
    await rm(path, { force: true });
    throw error;
  }
}

async function cleanOldUploads(dir: string): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > UPLOAD_TTL_MS) await rm(path, { force: true, recursive: true });
  }
}

export async function discardUpload(host: Host, id: string): Promise<void> {
  await rm(join(importDir(host), id), { force: true });
}

// ---------------------------------------------------------------------------- Import

/**
 * The DEFINER clauses of the dump are removed: the temporary user cannot create objects in someone else's name (and
 * must not be able to: DEFINER=root would run as root). Whatever survives this filter is rejected by MySQL.
 */
export const STRIP_DEFINER = [
  "-E",
  "-e", "s/DEFINER[[:space:]]*=[[:space:]]*(`[^`]*`|'[^']*'|[A-Za-z0-9_.$-]+)[[:space:]]*@[[:space:]]*(`[^`]*`|'[^']*'|[A-Za-z0-9_.%$-]+)//g",
  "-e", "s/DEFINER[[:space:]]*=[[:space:]]*CURRENT_USER([[:space:]]*[(][[:space:]]*[)])?//g",
];

/** Replaces the definer of a SHOW CREATE statement: objects belong to the database user, not to the temporary one. */
export function replaceDefiner(statement: string, from: string, to: string): string {
  const pattern = new RegExp(`DEFINER=\`${from}\`@\`localhost\``);
  if (!pattern.test(statement)) throw new Error("Unexpected definition while fixing the owner of an object");
  return statement.replace(pattern, `DEFINER=\`${to}\`@\`localhost\``);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const hex = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
const tail = (output: string) => output.trim().split("\n").slice(-3).join(" ").slice(0, 400) || "no details";

async function run(cmd: string[], options: { stdin?: ReadableStream<Uint8Array> | Bun.BunFile; stdout?: Bun.BunFile } = {}): Promise<void> {
  const proc = Bun.spawn(cmd, { env: TOOL_ENV, stdin: options.stdin ?? "ignore", stdout: options.stdout ?? "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${tail(stderr)}`);
}

/** source | sed | mysql, without a shell. The error that counts is the one from mysql: it says the line that failed. */
async function loadDump(file: string, gzip: boolean, sedArgs: string[], mysqlArgs: string[]): Promise<void> {
  const source = Bun.spawn(gzip ? ["gzip", "-dc", file] : ["cat", file], { env: TOOL_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const filter = Bun.spawn(["sed", ...sedArgs], { env: TOOL_ENV, stdin: source.stdout, stdout: "pipe", stderr: "pipe" });
  const mysql = Bun.spawn([dbClient(), ...mysqlArgs], { env: TOOL_ENV, stdin: filter.stdout, stdout: "ignore", stderr: "pipe" });
  const [sourceErr, sourceCode, filterErr, filterCode, mysqlErr, mysqlCode] = await Promise.all([
    new Response(source.stderr).text(), source.exited,
    new Response(filter.stderr).text(), filter.exited,
    new Response(mysql.stderr).text(), mysql.exited,
  ]);
  if (mysqlCode !== 0) throw new Error(`MySQL rejected the file: ${tail(mysqlErr)}`);
  if (sourceCode !== 0) throw new Error(`Could not read the file${gzip ? " (damaged gzip?)" : ""}: ${tail(sourceErr)}`);
  if (filterCode !== 0) throw new Error(`Could not process the file: ${tail(filterErr)}`);
}

async function isGzip(file: string): Promise<boolean> {
  const head = new Uint8Array(await Bun.file(file).slice(0, 2).arrayBuffer());
  return head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
}

async function recreate(sql: SqlClient, database: string): Promise<void> {
  // The privileges of the database user are on the name: they survive.
  await sql.query(`/* ep:drop */ DROP DATABASE IF EXISTS ${quoteName(database)}`);
  await sql.query(`/* ep:createdb */ CREATE DATABASE ${quoteName(database)} CHARACTER SET utf8mb4 COLLATE ${defaultCollation()}`);
  // Dropping it left the connection without a current database: SHOW CREATE gives unqualified names.
  await sql.query(`/* ep:use */ USE ${quoteName(database)}`);
}

async function killUser(sql: SqlClient, user: string): Promise<void> {
  const rows = await sql.query("/* ep:processes */ SELECT ID AS id FROM information_schema.PROCESSLIST WHERE USER = ?", [user]);
  for (const row of rows) {
    const id = num(row.id);
    if (id !== null) await sql.query(`/* ep:kill */ KILL ${id}`).catch(() => undefined);
  }
}

/** Objects the import created as the temporary user: they are recreated in the name of the database user. */
export async function reassignDefiners(sql: SqlClient, database: string, from: string, to: string): Promise<number> {
  const definer = `${from}@localhost`;
  const target = quoteName(database);
  let fixed = 0;
  // SHOW CREATE TRIGGER gives `ON t` unqualified: it is recreated from inside the database.
  await sql.query(`/* ep:use */ USE ${target}`);
  const views = await sql.query("/* ep:definer-views */ SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND DEFINER = ?", [database, definer]);
  for (const { name } of views) {
    const [row] = await sql.query(`/* ep:show */ SHOW CREATE VIEW ${target}.${quoteName(text(name))}`);
    const statement = replaceDefiner(text(row?.["Create View"]), from, to).replace(/^CREATE /, "CREATE OR REPLACE ");
    await sql.query(`/* ep:recreate */ ${statement}`);
    fixed++;
  }
  const kinds: { query: string; show: string; drop: string; column: string }[] = [
    { query: "SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND DEFINER = ?", show: "TRIGGER", drop: "TRIGGER", column: "SQL Original Statement" },
    { query: "SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND DEFINER = ? AND ROUTINE_TYPE = 'PROCEDURE'", show: "PROCEDURE", drop: "PROCEDURE", column: "Create Procedure" },
    { query: "SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND DEFINER = ? AND ROUTINE_TYPE = 'FUNCTION'", show: "FUNCTION", drop: "FUNCTION", column: "Create Function" },
    { query: "SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? AND DEFINER = ?", show: "EVENT", drop: "EVENT", column: "Create Event" },
  ];
  for (const kind of kinds) {
    for (const { name } of await sql.query(`/* ep:definer */ ${kind.query}`, [database, definer])) {
      const ref = `${target}.${quoteName(text(name))}`;
      const [row] = await sql.query(`/* ep:show */ SHOW CREATE ${kind.show} ${ref}`);
      const statement = replaceDefiner(text(row?.[kind.column]), from, to);
      // The same sql_mode it was created with: it changes how the body is interpreted.
      await sql.query("/* ep:sqlmode */ SET SESSION sql_mode = ?", [text(row?.sql_mode)]);
      await sql.query(`/* ep:drop-object */ DROP ${kind.drop} ${ref}`);
      await sql.query(`/* ep:recreate */ ${statement}`);
      fixed++;
    }
  }
  return fixed;
}

export async function importDatabase(host: Host, database: string, upload: string, replace: boolean): Promise<void> {
  const dir = importDir(host);
  const file = join(dir, upload);
  if (!(await Bun.file(file).exists())) throw new Error("The uploaded file is no longer available: upload it again");
  if (host.sandbox) {
    await rm(file, { force: true });
    return;
  }

  const before = `${file}.before.sql.gz`;
  const credentials = `${file}.cnf`;
  const user = `ep_import_${hex(4)}`;
  const sql = await rootSql();
  try {
    if (!(await databaseExists(sql, database))) throw new Error("The database does not exist");
    // SHOW CREATE gives unqualified names: the objects are recreated from inside the database.
    await sql.query(`/* ep:use */ USE ${quoteName(database)}`);
    // A copy of how it is now: if anything fails, it is put back.
    const dump = Bun.spawn(dumpArgs(database, false), { env: TOOL_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [, dumpErr, dumpCode] = await Promise.all([
      run(["gzip", "-c"], { stdin: dump.stdout, stdout: Bun.file(before) }),
      new Response(dump.stderr).text(),
      dump.exited,
    ]);
    if (dumpCode !== 0) throw new Error(`Could not copy the database before importing: ${tail(dumpErr)}`);

    const password = hex(16);
    await Bun.write(credentials, `[client]\nuser=${user}\npassword=${password}\nsocket=${MYSQL_SOCKET}\n`, { mode: 0o600 });
    await sql.query(`/* ep:create-user */ CREATE USER '${user}'@'localhost' IDENTIFIED BY '${password}' WITH MAX_USER_CONNECTIONS 2`);
    try {
      await sql.query(`/* ep:grant */ GRANT ALL ON ${grantTarget(database)} TO '${user}'@'localhost'`);
      if (replace) await recreate(sql, database);
      await loadDump(file, await isGzip(file), [...STRIP_DEFINER, ...collationFix()], [
        `--defaults-extra-file=${credentials}`, "--protocol=socket", "--one-database", "--default-character-set=utf8mb4", database,
      ]);
      await reassignDefiners(sql, database, user, database);
    } catch (error) {
      await killUser(sql, user).catch(() => undefined);
      try {
        await recreate(sql, database);
        // The copy was made by mysqldump from this same database: it goes back as root, without filters.
        await loadDump(before, true, ["-e", ""], ["--protocol=socket", "-uroot", "--one-database", "--default-character-set=utf8mb4", database]);
      } catch (restoreError) {
        // The copy is kept: it is the only way back.
        throw new Error(`${errorText(error)}. The previous state could not be restored either (${errorText(restoreError)}); its copy is at ${before}`);
      }
      await rm(before, { force: true });
      throw error;
    } finally {
      await killUser(sql, user).catch(() => undefined);
      await sql.query(`/* ep:drop-user */ DROP USER IF EXISTS '${user}'@'localhost'`);
    }
    await rm(before, { force: true });
  } finally {
    await sql.close();
    await rm(credentials, { force: true });
    await rm(file, { force: true });
  }
}

// ---------------------------------------------------------------------------- SQL console, row editing, table forms

/**
 * Privileges of the temporary user of each access level. `blocked` matches what an account over its limit keeps
 * (services.ts): it can read and free space, not grow.
 */
export const ACCESS_PRIVILEGES: Record<DbAccess, string> = {
  full: "ALL",
  blocked: "SELECT, DELETE, DROP, SHOW VIEW, LOCK TABLES",
  readonly: "SELECT, SHOW VIEW",
};

/** Any value Bun.SQL returns, as the text the grid shows. */
export function formatValue(value: unknown, limit: number): string | null {
  if (value === null || value === undefined) return null;
  let out: string;
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    out = `0x${bytes.subarray(0, BINARY_PREVIEW_BYTES).toString("hex").toUpperCase()}${bytes.length > BINARY_PREVIEW_BYTES ? `... (${bytes.length} bytes)` : ""}`;
  } else if (value instanceof Date) {
    out = Number.isNaN(value.getTime()) ? "0000-00-00 00:00:00" : value.toISOString().replace("T", " ").replace(/(\.000)?Z$/, "");
  } else if (typeof value === "object") {
    out = JSON.stringify(value);
  } else {
    out = String(value);
  }
  return out.length > limit ? `${out.slice(0, limit)}…` : out;
}

export interface StatementResult {
  columns: string[];
  rows: unknown[][];
  affectedRows: number;
  insertId: number | null;
}

/** A connection as the temporary user. Separate from SqlClient: its errors are the account's, shown as they are. */
export interface UserConnection {
  run(text: string, params?: unknown[]): Promise<StatementResult>;
  close(): Promise<void>;
}

interface RawMeta {
  columns?: { name: string; type: number; flags: number }[];
  affectedRows?: number;
  count?: number;
  lastInsertRowid?: number | bigint | null;
}

const BINARY_FLAG = 128;
/** BIT and spatial values are bytes; strings and blobs with the binary flag may be (BINARY, VARBINARY, BLOB) or not (_bin collations). */
const BYTE_TYPES = new Set([16, 255]);
const STRING_TYPES = new Set([15, 249, 250, 251, 252, 253, 254]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A value of a text-protocol answer: the text MySQL wrote, or the bytes when it is not text. */
export function decodeRaw(value: Uint8Array | null, field?: { type: number; flags: number }): string | Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (field && BYTE_TYPES.has(field.type)) return value;
  if (field && STRING_TYPES.has(field.type) && field.flags & BINARY_FLAG) {
    try {
      const decoded = utf8.decode(value);
      return /[\x00-\x08\x0e-\x1f]/.test(decoded) ? value : decoded;
    } catch {
      return value;
    }
  }
  return new TextDecoder().decode(value);
}

export type UserConnector =(user: string, password: string, database: string) => Promise<UserConnection>;

export const connectAsUser: UserConnector = async (user, password, database) => {
  const sql = new SQL({ adapter: "mysql", path: MYSQL_SOCKET, username: user, password, database, max: 1, idleTimeout: 30 });
  return {
    run: async (text, params = []) => {
      // Without parameters MySQL answers in text, and .raw() keeps it as it is: a DATE stays a date, microseconds and
      // decimals are not rounded. With parameters (only the panel's own forms) the answer is binary and Bun decodes it.
      const raw = params.length === 0;
      const result = raw ? await sql.unsafe(text).raw() : await sql.unsafe(text, params);
      const meta = result as unknown as RawMeta;
      const fields = meta.columns ?? [];
      const columns = fields.length ? fields.map((field) => field.name) : Object.keys((result[0] ?? {}) as object);
      const rows = raw
        ? (result as unknown as (Uint8Array | null)[][]).map((row) => row.map((value, index) => decodeRaw(value, fields[index])))
        : [...result].map((row) => columns.map((column) => (row as Record<string, unknown>)[column]));
      const insertId = meta.lastInsertRowid === null || meta.lastInsertRowid === undefined ? null : Number(meta.lastInsertRowid);
      return { columns, rows, affectedRows: Number(meta.affectedRows ?? meta.count ?? 0), insertId: insertId || null };
    },
    close: () => sql.close(),
  };
};

/**
 * Runs one statement as a temporary MySQL user with privileges on this database only, created for this statement and
 * dropped after it. Whatever the SQL says, it cannot reach another database, mysql.* or the server: MySQL refuses it.
 * Objects it creates (views, triggers, routines) end up owned by the database user, as with an import.
 */
export async function executeStatement(
  root: SqlClient,
  connect: UserConnector,
  database: string,
  access: DbAccess,
  request: ExecuteRequest,
): Promise<ExecuteResultDto> {
  if (hasSeveralStatements(request.sql)) throw new Error("Run one statement at a time; for a script, use Import");
  if (!(await databaseExists(root, database))) throw new Error("The database does not exist");
  const params = request.params ?? [];
  const full = request.full ?? false;
  const user = `ep_sql_${hex(4)}`;
  const password = hex(16);
  await root.query(`/* ep:create-user */ CREATE USER '${user}'@'localhost' IDENTIFIED BY '${password}' WITH MAX_USER_CONNECTIONS 1`);
  let connection: UserConnection | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  try {
    await root.query(`/* ep:grant */ GRANT ${ACCESS_PRIVILEGES[access]} ON ${grantTarget(database)} TO '${user}'@'localhost'`);
    connection = await connect(user, password, database);
    const maxRows = full ? 1 : MAX_RESULT_ROWS;
    // One row more than shown: that is how it knows there were more, without reading them all.
    // The time limit: MySQL's in milliseconds, MariaDB's in seconds (and it covers every statement).
    const timeLimit = dbEngine() === "mariadb" ? `max_statement_time = ${STATEMENT_TIMEOUT_SECONDS}` : `max_execution_time = ${STATEMENT_TIMEOUT_SECONDS * 1000}`;
    await connection.run(`SET SESSION sql_select_limit = ${maxRows + 1}, SESSION ${timeLimit}`);
    // MySQL's max_execution_time only stops SELECT: anything else is cut by root.
    timer = setTimeout(() => {
      timedOut = true;
      void killUser(root, user).catch(() => undefined);
    }, STATEMENT_TIMEOUT_SECONDS * 1000);
    const started = performance.now();
    let result: StatementResult;
    try {
      result = await connection.run(request.sql, params);
    } catch (error) {
      if (timedOut) throw new Error(`The statement took more than ${STATEMENT_TIMEOUT_SECONDS} seconds and was stopped`);
      throw error;
    }
    const ms = Math.round(performance.now() - started);
    if (!ROW_STATEMENTS.has(firstKeyword(request.sql))) {
      await reassignDefiners(root, database, user, database);
      return { kind: "done", affectedRows: result.affectedRows, insertId: result.insertId, ms };
    }
    const limit = full ? MAX_FULL_CELL_CHARS : MAX_CELL_CHARS;
    return {
      kind: "rows",
      columns: result.columns,
      rows: result.rows.slice(0, maxRows).map((row) => row.map((value) => formatValue(value, limit))),
      truncated: result.rows.length > maxRows,
      ms,
    };
  } finally {
    if (timer) clearTimeout(timer);
    await connection?.close().catch(() => undefined);
    await killUser(root, user).catch(() => undefined);
    await root.query(`/* ep:drop-user */ DROP USER IF EXISTS '${user}'@'localhost'`);
  }
}

/** Connections working on this database: of its own user, or anyone's with it selected. Never root or MySQL's own. */
export async function listProcesses(root: SqlClient, database: string): Promise<DbProcessDto[]> {
  const rows = await root.query(
    "/* ep:processlist */ SELECT ID AS id, USER AS user, COMMAND AS command, TIME AS seconds, STATE AS state, INFO AS info " +
      "FROM information_schema.PROCESSLIST WHERE (DB = ? OR USER = ?) AND USER NOT IN ('root', 'event_scheduler', 'system user') " +
      "AND ID <> CONNECTION_ID() ORDER BY TIME DESC",
    [database, database],
  );
  return rows.map((row) => ({
    id: num(row.id) ?? 0,
    user: text(row.user),
    command: text(row.command),
    seconds: num(row.seconds) ?? 0,
    state: text(row.state),
    info: row.info === null || row.info === undefined ? null : formatValue(text(row.info), MAX_CELL_CHARS),
  }));
}

export async function killProcess(root: SqlClient, database: string, id: number): Promise<void> {
  const owned = (await listProcesses(root, database)).some((process) => process.id === id);
  if (!owned) throw new Error("That connection does not belong to this database");
  await root.query(`/* ep:kill */ KILL ${Math.trunc(id)}`);
}
