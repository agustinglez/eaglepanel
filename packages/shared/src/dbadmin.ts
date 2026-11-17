import { z } from "zod";
import { dbNameSchema, usernameSchema } from "./validators";

/**
 * Database explorer: list tables, see their structure and browse rows; export with mysqldump and import a dump.
 * Table and column names come from the browser, but the agent only accepts the ones that exist in information_schema.
 */

/** MySQL allows up to 64 characters, any except NUL. They are matched against information_schema anyway. */
export const tableNameSchema = z.string().min(1).max(64).refine((value) => !value.includes("\0"), "Invalid name");
export const ROW_PAGE_SIZES = [25, 50, 100, 250] as const;
export const rowPageSizeSchema = z.union([z.literal(25), z.literal(50), z.literal(100), z.literal(250)]);
/** Longer values are cut: the grid shows a preview, not the whole cell. */
export const MAX_CELL_CHARS = 2000;
export const FILTER_OPERATORS = ["eq", "ne", "contains", "starts", "gt", "lt", "null", "notnull"] as const;
export const filterOperatorSchema = z.enum(FILTER_OPERATORS);
export type FilterOperator = z.infer<typeof filterOperatorSchema>;

export const rowQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  size: z.coerce.number().pipe(rowPageSizeSchema).default(50),
  sort: tableNameSchema.optional(),
  dir: z.enum(["asc", "desc"]).default("asc"),
  column: tableNameSchema.optional(),
  op: filterOperatorSchema.optional(),
  value: z.string().max(1000).optional(),
}).strict();
export type RowQuery = z.infer<typeof rowQuerySchema>;

export const dbTableSchema = z.object({
  name: z.string(),
  kind: z.enum(["table", "view"]),
  engine: z.string().nullable(),
  /** InnoDB estimate: it can differ from COUNT(*). */
  rows: z.number().nullable(),
  dataBytes: z.number(),
  indexBytes: z.number(),
  collation: z.string().nullable(),
  comment: z.string(),
});
export type DbTableDto = z.infer<typeof dbTableSchema>;

export const dbColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  default: z.string().nullable(),
  key: z.string(),
  extra: z.string(),
  comment: z.string(),
});
export type DbColumnDto = z.infer<typeof dbColumnSchema>;

export const dbIndexSchema = z.object({
  name: z.string(),
  unique: z.boolean(),
  type: z.string(),
  columns: z.array(z.string()),
});
export type DbIndexDto = z.infer<typeof dbIndexSchema>;

export const dbStructureSchema = z.object({
  kind: z.enum(["table", "view"]),
  columns: z.array(dbColumnSchema),
  indexes: z.array(dbIndexSchema),
  createSql: z.string(),
});
export type DbStructureDto = z.infer<typeof dbStructureSchema>;

export const dbRowsSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  /** Every value as text: dates, numbers and JSON exactly as MySQL writes them. Binary data, in hexadecimal. */
  rows: z.array(z.array(z.string().nullable())),
  /** `null` when counting took too long. */
  total: z.number().nullable(),
  /** False when it is the InnoDB estimate of a large table. */
  exact: z.boolean(),
});
export type DbRowsDto = z.infer<typeof dbRowsSchema>;

export const dbUploadIdSchema = z.string().regex(/^[0-9a-f]{32}$/, "Invalid upload");

/**
 * What a statement run from the panel may do. The agent turns it into the privileges of a temporary MySQL user on that
 * database only: `full` like the database user; `blocked` like an account over its limit (read and free space);
 * `readonly` for a suspended account.
 */
export const DB_ACCESS = ["full", "blocked", "readonly"] as const;
export const dbAccessSchema = z.enum(DB_ACCESS);
export type DbAccess = z.infer<typeof dbAccessSchema>;
/** Rows a statement returns at most: the rest is not even read (sql_select_limit). */
export const MAX_RESULT_ROWS = 1000;
/** A statement that takes longer is stopped. */
export const STATEMENT_TIMEOUT_SECONDS = 30;
/** With `full`, one cell is returned whole up to this size: it is how the grid edits a long value. */
export const MAX_FULL_CELL_CHARS = 1024 * 1024;

/** Statements that answer with rows even when there are none: the console shows an empty table, not "0 rows affected". */
export const ROW_STATEMENTS = new Set(["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH", "TABLE", "VALUES", "CHECK", "ANALYZE", "CHECKSUM", "OPTIMIZE", "REPAIR"]);

/** The first keyword, skipping comments and parentheses: `(SELECT ...)` and a leading comment are queries too. */
export function firstKeyword(sql: string): string {
  const stripped = sql.replace(/^(\s+|--[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/|\()+/, "");
  return /^[A-Za-z]+/.exec(stripped)?.[0]?.toUpperCase() ?? "";
}

const LEADING_NOISE = /^(\s+|;|--(?=\s|$)[^\n]*\n?|#[^\n]*\n?|\/\*(?![!+])[\s\S]*?\*\/)+/;
/** Bodies with BEGIN … END carry their own `;`, and MySQL parses them as a single statement. */
const COMPOUND = /^CREATE\s+(OR\s+REPLACE\s+)?(DEFINER\s*=\s*\S+\s+)?(AGGREGATE\s+)?(PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i;

/**
 * Whether the text has something after its first `;`, outside quotes and comments. The console runs one statement:
 * its keyword decides how it is answered and logged. Routines, triggers and events are let through as they are.
 */
export function hasSeveralStatements(sql: string): boolean {
  if (COMPOUND.test(sql.replace(LEADING_NOISE, ""))) return false;
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === "\"" || c === "`") {
      i++;
      while (i < n) {
        if (sql[i] === "\\" && c !== "`") i += 2;
        else if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) break;
        else i++;
      }
      i++;
    } else if (c === "#" || (c === "-" && sql[i + 1] === "-" && (i + 2 >= n || /\s/.test(sql[i + 2] ?? "")))) {
      while (i < n && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*" && sql[i + 2] !== "!" && sql[i + 2] !== "+") {
      const close = sql.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
    } else if (c === ";") {
      return sql.slice(i).replace(LEADING_NOISE, "") !== "";
    } else {
      i++;
    }
  }
  return false;
}

export const executeRequestSchema = z.object({
  sql: z.string().trim().min(1, "The statement is empty").max(200_000, "The statement is too long: use Import for scripts"),
  params: z.array(z.string().max(MAX_FULL_CELL_CHARS).nullable()).max(500).default([]),
  /** Values of one cell without cutting them, for editing. Only with a single row. */
  full: z.boolean().default(false),
}).strict();
export type ExecuteRequest = z.input<typeof executeRequestSchema>;

export const executeResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rows"),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string().nullable())),
    /** More rows than MAX_RESULT_ROWS: only those were read. */
    truncated: z.boolean(),
    ms: z.number(),
  }),
  z.object({
    kind: z.literal("done"),
    affectedRows: z.number(),
    insertId: z.number().nullable(),
    ms: z.number(),
  }),
]);
export type ExecuteResultDto = z.infer<typeof executeResultSchema>;

export const dbProcessSchema = z.object({
  id: z.number(),
  user: z.string(),
  command: z.string(),
  seconds: z.number(),
  state: z.string(),
  info: z.string().nullable(),
});
export type DbProcessDto = z.infer<typeof dbProcessSchema>;

const target = { username: usernameSchema, name: dbNameSchema };

export const dbAdminOps = {
  "db.tables": {
    params: z.object(target).strict(),
    result: z.object({ tables: z.array(dbTableSchema) }),
  },
  "db.structure": {
    params: z.object({ ...target, table: tableNameSchema }).strict(),
    result: dbStructureSchema,
  },
  "db.rows": {
    params: z.object({ ...target, table: tableNameSchema, query: rowQuerySchema }).strict(),
    result: dbRowsSchema,
  },
  /** Loads a dump uploaded before through /db/upload. If it fails, the database goes back to how it was. */
  "db.import": {
    params: z.object({ ...target, upload: dbUploadIdSchema, replace: z.boolean() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  /** One statement, as a temporary user with privileges on that database only. */
  "db.execute": {
    params: z.object({ ...target, access: dbAccessSchema, request: executeRequestSchema }).strict(),
    result: executeResultSchema,
  },
  /** Connections working on that database, of its user or of the panel. Never other databases or root. */
  "db.processes": {
    params: z.object(target).strict(),
    result: z.object({ processes: z.array(dbProcessSchema) }),
  },
  "db.kill": {
    params: z.object({ ...target, id: z.number().int().positive() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "db.discardUpload": {
    params: z.object({ upload: dbUploadIdSchema }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
} as const;
