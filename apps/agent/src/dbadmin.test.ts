import { describe, expect, test } from "bun:test";
import { buildRowsQuery, cellExpression, describeTable, filterClause, listTables, quoteName, readRows, replaceDefiner, STRIP_DEFINER, type SqlClient } from "./dbadmin";
import { sandboxSql } from "./dbadmin-sandbox";

const columns = [
  { name: "id", type: "int", dataType: "int", nullable: false, default: null, key: "PRI", extra: "", comment: "" },
  { name: "na`me", type: "varchar(10)", dataType: "varchar", nullable: true, default: null, key: "", extra: "", comment: "" },
  { name: "data", type: "blob", dataType: "blob", nullable: true, default: null, key: "", extra: "", comment: "" },
];
const page = { page: 1, size: 50 as const, dir: "asc" as const };

/** Records every query and answers with the sandbox data. */
function recording(): SqlClient & { queries: { text: string; params: unknown[] }[] } {
  const inner = sandboxSql();
  const queries: { text: string; params: unknown[] }[] = [];
  return {
    queries,
    query: (text, params = []) => {
      queries.push({ text, params });
      return inner.query(text, params);
    },
    close: () => inner.close(),
  };
}

describe("row queries", () => {
  test("names are quoted and backticks doubled", () => {
    expect(quoteName("a`b")).toBe("`a``b`");
  });

  test("filter values go as parameters, never in the SQL text", () => {
    const value = "x'; DROP TABLE users; --";
    const built = buildRowsQuery("acme_shop", "posts", columns, { ...page, column: "na`me", op: "eq", value });
    expect(built.sql).not.toContain(value);
    expect(built.sql).toContain("WHERE `na``me` = ?");
    expect(built.params).toEqual([value]);
  });

  test("contains and starts escape LIKE wildcards", () => {
    expect(filterClause(columns, { column: "id", op: "contains", value: "50%_\\" }).params).toEqual(["%50\\%\\_\\\\%"]);
    expect(filterClause(columns, { column: "id", op: "starts", value: "a" }).params).toEqual(["a%"]);
    expect(filterClause(columns, { column: "id", op: "null" })).toEqual({ sql: " WHERE `id` IS NULL", params: [] });
  });

  test("rejects columns the table does not have", () => {
    expect(() => buildRowsQuery("acme_shop", "posts", columns, { ...page, sort: "id`; DROP" })).toThrow("Unknown column");
    expect(() => buildRowsQuery("acme_shop", "posts", columns, { ...page, column: "nope", op: "eq", value: "1" })).toThrow("Unknown column");
  });

  test("orders by the primary key unless told otherwise, and pages with integers", () => {
    expect(buildRowsQuery("acme_shop", "posts", columns, { ...page, page: 3 }).sql).toEndWith("ORDER BY `id` LIMIT 50 OFFSET 100");
    expect(buildRowsQuery("acme_shop", "posts", columns, { ...page, sort: "na`me", dir: "desc" }).sql).toContain("ORDER BY `na``me` DESC");
  });

  test("binary columns are previewed in hexadecimal and the rest cut as text", () => {
    expect(cellExpression({ name: "data", dataType: "blob" })).toContain("HEX(SUBSTRING(`data`, 1, 32))");
    expect(cellExpression({ name: "title", dataType: "varchar" })).toContain("CAST(`title` AS CHAR CHARACTER SET utf8mb4)");
    expect(cellExpression({ name: "flags", dataType: "bit" })).toContain("CAST(`flags` + 0 AS CHAR)");
  });
});

describe("browsing", () => {
  test("only uses a table after finding it in information_schema", async () => {
    const sql = recording();
    const error = await readRows(sql, "acme_shop", "nope", page).then(() => null, (reason: Error) => reason.message);
    expect(error).toBe("Table not found");
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]?.params).toEqual(["acme_shop", "nope"]);
  });

  test("lists tables and views", async () => {
    const tables = await listTables(sandboxSql(), "acme_shop");
    expect(tables.map((table) => [table.name, table.kind])).toEqual([["posts", "table"], ["settings", "table"], ["published_posts", "view"]]);
    expect(tables.find((table) => table.kind === "view")?.rows).toBeNull();
  });

  test("structure groups index columns", async () => {
    const structure = await describeTable(sandboxSql(), "acme_shop", "posts");
    expect(structure.indexes).toEqual([
      { name: "PRIMARY", unique: true, type: "BTREE", columns: ["id"] },
      { name: "posts_published", unique: false, type: "BTREE", columns: ["published_at"] },
    ]);
    expect(structure.columns[0]).toMatchObject({ name: "id", nullable: false, key: "PRI" });
  });

  test("rows come back in column order, with the total", async () => {
    const rows = await readRows(sandboxSql(), "acme_shop", "settings", page);
    expect(rows.columns.map((column) => column.name)).toEqual(["name", "value"]);
    expect(rows.rows[0]).toEqual(["site_name", "\"Demo\""]);
    expect(rows).toMatchObject({ total: 2, exact: true });
  });
});

describe("import", () => {
  test("the definer of a recreated object becomes the database user", () => {
    const statement = "CREATE DEFINER=`ep_import_ab12cd34`@`localhost` TRIGGER `t` AFTER INSERT ON `posts` FOR EACH ROW SET @a = 1";
    expect(replaceDefiner(statement, "ep_import_ab12cd34", "acme_shop")).toBe("CREATE DEFINER=`acme_shop`@`localhost` TRIGGER `t` AFTER INSERT ON `posts` FOR EACH ROW SET @a = 1");
    expect(() => replaceDefiner("CREATE DEFINER=`root`@`localhost` VIEW v AS select 1", "ep_import_ab12cd34", "acme_shop")).toThrow();
  });

  // GNU sed, the one on the server: the Windows one mangles arguments with quotes.
  test.skipIf(process.platform !== "linux")("strips every form of DEFINER from the dump", async () => {
    const input = [
      "/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */",
      "CREATE DEFINER = 'admin'@'%' PROCEDURE p() SELECT 1;",
      "CREATE DEFINER=root@localhost FUNCTION f() RETURNS int RETURN 1;",
      "CREATE DEFINER=CURRENT_USER() TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET @a = 1;",
    ].join("\n");
    const proc = Bun.spawn(["sed", ...STRIP_DEFINER], { stdin: new TextEncoder().encode(input), stdout: "pipe" });
    const output = await new Response(proc.stdout).text();
    expect(output).not.toMatch(/DEFINER\s*=/);
    expect(output).toContain("SQL SECURITY DEFINER");
  });
});
