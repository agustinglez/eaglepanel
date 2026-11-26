/**
 * SQL built by the table forms. It runs as a temporary MySQL user limited to the database, so a mistake here can only
 * affect that database; still, names and literals are always quoted.
 */
import type { DbColumnDto, DbIndexDto, DbStructureDto } from "@eaglepanel/shared";

export const quoteName = (name: string) => `\`${name.replaceAll("`", "``")}\``;
export const quoteLiteral = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

/** Types offered in the forms; any other MySQL type can be typed by hand. */
export const COMMON_TYPES = [
  "int", "int unsigned", "bigint", "bigint unsigned", "tinyint(1)", "smallint", "decimal(10,2)", "float", "double",
  "varchar(255)", "char(36)", "text", "mediumtext", "longtext", "json",
  "date", "datetime", "timestamp", "time", "year", "blob", "longblob", "enum('a','b')",
];

export type DefaultMode = "none" | "null" | "value" | "expression";

export interface ColumnSpec {
  name: string;
  type: string;
  nullable: boolean;
  defaultMode: DefaultMode;
  defaultValue: string;
  autoIncrement: boolean;
  onUpdateNow: boolean;
  comment: string;
}

export const emptyColumn = (): ColumnSpec => ({
  name: "", type: "varchar(255)", nullable: true, defaultMode: "none", defaultValue: "", autoIncrement: false, onUpdateNow: false, comment: "",
});

export const supportsOnUpdate = (type: string) => /^(datetime|timestamp)\b/i.test(type.trim());

/** The column as the form edits it, from what information_schema says. */
export function columnSpecOf(column: DbColumnDto): ColumnSpec {
  const extra = column.extra.toLowerCase();
  const expression = extra.includes("default_generated");
  return {
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    defaultMode: column.default === null ? (column.nullable && !expression ? "null" : "none") : expression ? "expression" : "value",
    defaultValue: column.default ?? "",
    autoIncrement: extra.includes("auto_increment"),
    onUpdateNow: extra.includes("on update current_timestamp"),
    comment: column.comment,
  };
}

/** `name type [NOT NULL] [DEFAULT ...] [AUTO_INCREMENT] [ON UPDATE ...] [COMMENT ...]` */
export function columnDefinition(spec: ColumnSpec): string {
  const parts = [quoteName(spec.name.trim()), spec.type.trim(), spec.nullable ? "NULL" : "NOT NULL"];
  if (spec.defaultMode === "null") parts.push("DEFAULT NULL");
  if (spec.defaultMode === "value") parts.push(`DEFAULT ${quoteLiteral(spec.defaultValue)}`);
  // An expression goes in parentheses (MySQL 8), except the ones MySQL accepts bare.
  if (spec.defaultMode === "expression") {
    const expression = spec.defaultValue.trim();
    parts.push(`DEFAULT ${/^(CURRENT_TIMESTAMP|NOW|LOCALTIME|LOCALTIMESTAMP)(\(\d?\))?$/i.test(expression) ? expression : `(${expression})`}`);
  }
  if (spec.autoIncrement) parts.push("AUTO_INCREMENT");
  if (spec.onUpdateNow && supportsOnUpdate(spec.type)) parts.push("ON UPDATE CURRENT_TIMESTAMP");
  if (spec.comment.trim()) parts.push(`COMMENT ${quoteLiteral(spec.comment.trim())}`);
  return parts.join(" ");
}

/** Without a charset: the table takes the database's (utf8mb4 with the collation of MySQL or MariaDB). */
export function createTableSql(table: string, columns: ColumnSpec[], primary: string[], comment: string): string {
  const lines = columns.map((column) => `  ${columnDefinition(column)}`);
  if (primary.length > 0) lines.push(`  PRIMARY KEY (${primary.map(quoteName).join(", ")})`);
  return `CREATE TABLE ${quoteName(table.trim())} (\n${lines.join(",\n")}\n) ENGINE=InnoDB${comment.trim() ? ` COMMENT=${quoteLiteral(comment.trim())}` : ""}`;
}

export type ColumnPosition = { kind: "end" } | { kind: "first" } | { kind: "after"; column: string };

const positionSql = (position: ColumnPosition) =>
  position.kind === "first" ? " FIRST" : position.kind === "after" ? ` AFTER ${quoteName(position.column)}` : "";

export const addColumnSql = (table: string, spec: ColumnSpec, position: ColumnPosition) =>
  `ALTER TABLE ${quoteName(table)} ADD COLUMN ${columnDefinition(spec)}${positionSql(position)}`;

/** CHANGE renames and redefines in one step. */
export const changeColumnSql = (table: string, previous: string, spec: ColumnSpec) =>
  `ALTER TABLE ${quoteName(table)} CHANGE COLUMN ${quoteName(previous)} ${columnDefinition(spec)}`;

export const dropColumnSql = (table: string, column: string) => `ALTER TABLE ${quoteName(table)} DROP COLUMN ${quoteName(column)}`;

export type IndexKind = "PRIMARY" | "UNIQUE" | "INDEX" | "FULLTEXT";

export function addIndexSql(table: string, kind: IndexKind, name: string, columns: string[]): string {
  const list = `(${columns.map(quoteName).join(", ")})`;
  if (kind === "PRIMARY") return `ALTER TABLE ${quoteName(table)} ADD PRIMARY KEY ${list}`;
  const keyword = kind === "UNIQUE" ? "UNIQUE INDEX" : kind === "FULLTEXT" ? "FULLTEXT INDEX" : "INDEX";
  return `ALTER TABLE ${quoteName(table)} ADD ${keyword} ${quoteName(name.trim())} ${list}`;
}

export const dropIndexSql = (table: string, index: string) =>
  index === "PRIMARY" ? `ALTER TABLE ${quoteName(table)} DROP PRIMARY KEY` : `ALTER TABLE ${quoteName(table)} DROP INDEX ${quoteName(index)}`;

export const renameTableSql = (table: string, next: string) => `RENAME TABLE ${quoteName(table)} TO ${quoteName(next.trim())}`;
export const truncateTableSql = (table: string) => `TRUNCATE TABLE ${quoteName(table)}`;
export const dropTableSql = (table: string, view: boolean) => `DROP ${view ? "VIEW" : "TABLE"} ${quoteName(table)}`;

// ---------------------------------------------------------------------------- Rows

const BINARY = /^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bit|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|geomcollection)\b/i;

/** Columns the row form can write: not binary or spatial (the grid only has a preview) and not generated. */
export function isEditableColumn(column: DbColumnDto): boolean {
  return !BINARY.test(column.type) && !/\b(VIRTUAL|STORED) GENERATED\b/i.test(column.extra);
}

/**
 * What identifies a row: the primary key or, failing that, a unique index of NOT NULL columns. Without one, a row
 * cannot be told apart from an identical one, and the grid does not edit it.
 */
export function rowKey(structure: DbStructureDto): string[] | null {
  if (structure.kind !== "table") return null;
  const byName = new Map(structure.columns.map((column) => [column.name, column]));
  const usable = (index: DbIndexDto) => index.unique && index.columns.every((name) => {
    const column = byName.get(name);
    return column && !column.nullable && !BINARY.test(column.type);
  });
  const primary = structure.indexes.find((index) => index.name === "PRIMARY" && usable(index));
  const unique = primary ?? structure.indexes.find(usable);
  return unique ? unique.columns : null;
}

const whereKey = (key: string[]) => key.map((column) => `${quoteName(column)} = ?`).join(" AND ");

/** The whole row as text, exactly as MySQL writes each value, to fill the edit form. */
export function selectRowSql(table: string, columns: DbColumnDto[], key: string[]): string {
  const select = columns.map((column) => (isEditableColumn(column)
    ? `CAST(${quoteName(column.name)} AS CHAR CHARACTER SET utf8mb4) AS ${quoteName(column.name)}`
    : `NULL AS ${quoteName(column.name)}`)).join(", ");
  return `SELECT ${select} FROM ${quoteName(table)} WHERE ${whereKey(key)} LIMIT 1`;
}

export function updateRowSql(table: string, changes: { column: string; value: string | null }[], key: string[]): { sql: string; params: (string | null)[] } {
  const set = changes.map(({ column, value }) => (value === null ? `${quoteName(column)} = NULL` : `${quoteName(column)} = ?`)).join(", ");
  return { sql: `UPDATE ${quoteName(table)} SET ${set} WHERE ${whereKey(key)} LIMIT 1`, params: changes.flatMap(({ value }) => (value === null ? [] : [value])) };
}

export function insertRowSql(table: string, values: { column: string; value: string | null }[]): { sql: string; params: (string | null)[] } {
  if (values.length === 0) return { sql: `INSERT INTO ${quoteName(table)} () VALUES ()`, params: [] };
  return {
    sql: `INSERT INTO ${quoteName(table)} (${values.map(({ column }) => quoteName(column)).join(", ")}) VALUES (${values.map(({ value }) => (value === null ? "NULL" : "?")).join(", ")})`,
    params: values.flatMap(({ value }) => (value === null ? [] : [value])),
  };
}

export const deleteRowSql = (table: string, key: string[]) => `DELETE FROM ${quoteName(table)} WHERE ${whereKey(key)} LIMIT 1`;
