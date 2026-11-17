/**
 * Sandbox mode has no MySQL: these answers, by query marker, let the explorer be developed and shown with sample
 * data. They follow the same shapes information_schema returns.
 */
import { firstKeyword } from "@eaglepanel/shared";
import type { SqlClient, UserConnector } from "./dbadmin";

const TABLES = [
  { name: "posts", type: "BASE TABLE", engine: "InnoDB", row_count: 3, data_bytes: 16384, index_bytes: 16384, collation_name: "utf8mb4_0900_ai_ci", comment: "Blog posts" },
  { name: "settings", type: "BASE TABLE", engine: "InnoDB", row_count: 2, data_bytes: 16384, index_bytes: 0, collation_name: "utf8mb4_0900_ai_ci", comment: "" },
  { name: "published_posts", type: "VIEW", engine: null, row_count: null, data_bytes: null, index_bytes: null, collation_name: null, comment: "VIEW" },
];

const COLUMNS: Record<string, { name: string; column_type: string; data_type: string; nullable: string; default_value: string | null; column_key: string; extra: string; comment: string }[]> = {
  posts: [
    { name: "id", column_type: "bigint unsigned", data_type: "bigint", nullable: "NO", default_value: null, column_key: "PRI", extra: "auto_increment", comment: "" },
    { name: "title", column_type: "varchar(200)", data_type: "varchar", nullable: "NO", default_value: null, column_key: "", extra: "", comment: "" },
    { name: "body", column_type: "text", data_type: "text", nullable: "YES", default_value: null, column_key: "", extra: "", comment: "" },
    { name: "published_at", column_type: "datetime", data_type: "datetime", nullable: "YES", default_value: null, column_key: "MUL", extra: "", comment: "" },
  ],
  settings: [
    { name: "name", column_type: "varchar(64)", data_type: "varchar", nullable: "NO", default_value: null, column_key: "PRI", extra: "", comment: "" },
    { name: "value", column_type: "json", data_type: "json", nullable: "YES", default_value: null, column_key: "", extra: "", comment: "" },
  ],
  published_posts: [
    { name: "id", column_type: "bigint unsigned", data_type: "bigint", nullable: "NO", default_value: "0", column_key: "", extra: "", comment: "" },
    { name: "title", column_type: "varchar(200)", data_type: "varchar", nullable: "NO", default_value: null, column_key: "", extra: "", comment: "" },
  ],
};

const ROWS: Record<string, (string | null)[][]> = {
  posts: [
    ["1", "Hello world", "First post of the blog.", "2026-10-01 09:30:00"],
    ["2", "Second post", null, "2026-10-15 18:00:00"],
    ["3", "Draft", "Not published yet.", null],
  ],
  settings: [
    ["site_name", "\"Demo\""],
    ["theme", "{\"dark\": true}"],
  ],
  published_posts: [
    ["1", "Hello world"],
    ["2", "Second post"],
  ],
};

const marker = (text: string) => /^\/\* ep:([a-z-]+) \*\//.exec(text)?.[1] ?? "";

export function sandboxSql(): SqlClient {
  return {
    async query(text, params = []) {
      const table = String(params[1] ?? "");
      switch (marker(text)) {
        case "schema": return [{ name: params[0] }];
        case "tables": return TABLES;
        case "table": return TABLES.filter((row) => row.name === table);
        case "columns": return COLUMNS[table] ?? [];
        case "indexes":
          return table === "posts"
            ? [
              { name: "PRIMARY", non_unique: 0, index_type: "BTREE", column_name: "id", expression: null },
              { name: "posts_published", non_unique: 1, index_type: "BTREE", column_name: "published_at", expression: null },
            ]
            : table === "settings" ? [{ name: "PRIMARY", non_unique: 0, index_type: "BTREE", column_name: "name", expression: null }] : [];
        case "create": {
          const name = /`([^`]+)`$/.exec(text)?.[1] ?? "";
          return name === "published_posts"
            ? [{ "Create View": "CREATE VIEW `published_posts` AS select `id`,`title` from `posts` where `published_at` is not null" }]
            : [{ "Create Table": `CREATE TABLE \`${name}\` (\n  -- sample definition (sandbox)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4` }];
        }
        case "rows": {
          const name = /FROM `[^`]+`\.`([^`]+)`/.exec(text)?.[1] ?? "";
          return (ROWS[name] ?? []).map((row) => Object.fromEntries(row.map((value, index) => [`c${index}`, value])));
        }
        case "count": {
          const name = /FROM `[^`]+`\.`([^`]+)`/.exec(text)?.[1] ?? "";
          return [{ n: (ROWS[name] ?? []).length }];
        }
        case "processlist":
          return [{ id: 41, user: String(params[1] ?? ""), command: "Sleep", seconds: 12, state: "", info: null }];
        default: return [];
      }
    },
    async close() {},
  };
}

/** The temporary user of the SQL console: queries over the sample tables answer with their rows; anything else, one row affected. */
export const sandboxConnector: UserConnector = async () => ({
  async run(text) {
    if (/^SET SESSION/.test(text)) return { columns: [], rows: [], affectedRows: 0, insertId: null };
    if (["SELECT", "SHOW", "WITH", "TABLE", "DESCRIBE", "DESC", "EXPLAIN"].includes(firstKeyword(text))) {
      const table = /\bFROM\s+`?([A-Za-z0-9_]+)`?/i.exec(text)?.[1] ?? "";
      const columns = COLUMNS[table]?.map((column) => column.name);
      if (!columns) return { columns: ["result"], rows: [[1]], affectedRows: 0, insertId: null };
      return { columns, rows: ROWS[table] ?? [], affectedRows: 0, insertId: null };
    }
    return { columns: [], rows: [], affectedRows: 1, insertId: /^\s*INSERT/i.test(text) ? 4 : null };
  },
  async close() {},
});
