import { describe, expect, test } from "bun:test";
import { firstKeyword, hasSeveralStatements } from "@eaglepanel/shared";
import { ACCESS_PRIVILEGES, decodeRaw, executeStatement, formatValue, killProcess, listProcesses, type SqlClient, type StatementResult, type UserConnector } from "./dbadmin";

/** Root as seen by the console: records statements; the database exists and has one connection of its user. */
function fakeRoot() {
  const queries: string[] = [];
  const root: SqlClient = {
    async query(text) {
      queries.push(text);
      if (text.includes("ep:schema")) return [{ name: "acme_shop" }];
      if (text.includes("ep:processlist")) return [{ id: 7, user: "acme_shop", command: "Query", seconds: 3, state: "executing", info: "SELECT 1" }];
      return [];
    },
    async close() {},
  };
  return { root, queries };
}

function connector(result: Partial<StatementResult> | Error) {
  const seen: { user: string; database: string; statements: { text: string; params: unknown[] }[] } = { user: "", database: "", statements: [] };
  const connect: UserConnector = async (user, _password, database) => {
    seen.user = user;
    seen.database = database;
    return {
      async run(text, params = []) {
        seen.statements.push({ text, params });
        if (text.startsWith("SET SESSION")) return { columns: [], rows: [], affectedRows: 0, insertId: null };
        if (result instanceof Error) throw result;
        return { columns: [], rows: [], affectedRows: 0, insertId: null, ...result };
      },
      async close() {},
    };
  };
  return { connect, seen };
}

describe("console", () => {
  test.each([
    ["full", "ALL"],
    ["blocked", "SELECT, DELETE, DROP, SHOW VIEW, LOCK TABLES"],
    ["readonly", "SELECT, SHOW VIEW"],
  ] as const)("a %s statement runs as a temporary user with %s on this database only", async (access, privileges) => {
    const { root, queries } = fakeRoot();
    const { connect, seen } = connector({ affectedRows: 2 });
    const result = await executeStatement(root, connect, "acme_shop", access, { sql: "DELETE FROM t WHERE id < ?", params: ["3"] });
    expect(result).toMatchObject({ kind: "done", affectedRows: 2 });
    expect(ACCESS_PRIVILEGES[access]).toBe(privileges);
    expect(seen.user).toMatch(/^ep_sql_[0-9a-f]{8}$/);
    expect(seen.database).toBe("acme_shop");
    expect(queries.find((query) => query.includes("ep:grant"))).toBe(`/* ep:grant */ GRANT ${privileges} ON \`acme\\_shop\`.* TO '${seen.user}'@'localhost'`);
    expect(seen.statements.at(-1)).toEqual({ text: "DELETE FROM t WHERE id < ?", params: ["3"] });
    expect(queries.at(-1)).toBe(`/* ep:drop-user */ DROP USER IF EXISTS '${seen.user}'@'localhost'`);
  });

  test("the temporary user is dropped even when MySQL rejects the statement", async () => {
    const { root, queries } = fakeRoot();
    const { connect, seen } = connector(new Error("Access denied for user"));
    const error = await executeStatement(root, connect, "acme_shop", "full", { sql: "SELECT * FROM mysql.user" }).then(() => null, (reason: Error) => reason.message);
    expect(error).toBe("Access denied for user");
    expect(queries.at(-1)).toContain(`DROP USER IF EXISTS '${seen.user}'`);
  });

  test("reads return at most the limit, and say so", async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => [index, `n${index}`]);
    const { root } = fakeRoot();
    const { connect, seen } = connector({ columns: ["id", "name"], rows });
    const result = await executeStatement(root, connect, "acme_shop", "readonly", { sql: "SELECT id, name FROM t" });
    expect(result).toMatchObject({ kind: "rows", columns: ["id", "name"], truncated: true });
    if (result.kind === "rows") expect(result.rows).toHaveLength(1000);
    // The limit is MySQL's: it does not read the rest.
    expect(seen.statements[0]?.text).toBe("SET SESSION sql_select_limit = 1001, SESSION max_execution_time = 30000");
  });

  test("an empty read is still a table, not rows affected", async () => {
    const { root } = fakeRoot();
    const { connect } = connector({ columns: ["one"], rows: [] });
    expect(await executeStatement(root, connect, "acme_shop", "full", { sql: "  /* x */ SELECT 1 AS one FROM t WHERE 0" })).toMatchObject({ kind: "rows", columns: ["one"], rows: [] });
  });

  test("a change reassigns what it created to the database user", async () => {
    const { root, queries } = fakeRoot();
    const { connect } = connector({ affectedRows: 0 });
    await executeStatement(root, connect, "acme_shop", "full", { sql: "CREATE VIEW v AS SELECT 1" });
    expect(queries.some((query) => query.includes("ep:definer-views"))).toBe(true);
  });

  test("one statement at a time, before any user is created", async () => {
    const { root, queries } = fakeRoot();
    const { connect } = connector({});
    const error = await executeStatement(root, connect, "acme_shop", "full", { sql: "SELECT 1; DROP TABLE t" }).then(() => null, (reason: Error) => reason.message);
    expect(error).toBe("Run one statement at a time; for a script, use Import");
    expect(queries).toEqual([]);
  });

  test.each([
    ["SELECT 1", false],
    ["SELECT 1;", false],
    ["SELECT 1; -- done\n ;  /* end */", false],
    ["SELECT 'a;b', `c;d`, \"e;f\" FROM t # x;y", false],
    ["SELECT 'it\\'s;' FROM t", false],
    ["SELECT 1; SELECT 2", true],
    ["SELECT 1;/*!50000 DROP TABLE t */", true],
    ["UPDATE t SET a = 1; DELETE FROM t", true],
    ["CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END", false],
    ["/* x */ CREATE DEFINER=`a`@`localhost` TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END", false],
  ])("%p has several statements: %p", (sql, several) => {
    expect(hasSeveralStatements(sql)).toBe(several);
  });

  test("the first keyword skips comments and parentheses", () => {
    expect(firstKeyword("-- note\n  (select 1)")).toBe("SELECT");
    expect(firstKeyword("/* a */ /* b */ update t set x = 1")).toBe("UPDATE");
    expect(firstKeyword("# x\nWITH a AS (SELECT 1) SELECT * FROM a")).toBe("WITH");
  });
});

describe("values", () => {
  test.each([
    [null, null],
    [42, "42"],
    ["18446744073709551615", "18446744073709551615"],
    [new Date("2026-01-02T03:04:05.000Z"), "2026-01-02 03:04:05"],
    [new Date("2026-01-02T03:04:05.120Z"), "2026-01-02 03:04:05.120"],
    [{ a: 1 }, "{\"a\":1}"],
    [new Uint8Array([0, 255]), "0x00FF"],
  ])("%p is shown as %p", (value, shown) => {
    expect(formatValue(value, 2000)).toBe(shown);
  });

  test("text answers keep MySQL's own text; bytes stay bytes", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(decodeRaw(bytes("2026-01-02"), { type: 10, flags: 0 })).toBe("2026-01-02");
    expect(decodeRaw(null, { type: 10, flags: 0 })).toBeNull();
    expect(decodeRaw(new Uint8Array([5]), { type: 16, flags: 32 })).toEqual(new Uint8Array([5]));
    expect(decodeRaw(new Uint8Array([0, 255]), { type: 253, flags: 128 })).toEqual(new Uint8Array([0, 255]));
    expect(decodeRaw(bytes("Ñandú"), { type: 253, flags: 128 })).toBe("Ñandú");
  });

  test("long values are cut, long binaries summarised", () => {
    expect(formatValue("x".repeat(10), 4)).toBe("xxxx…");
    expect(formatValue(new Uint8Array(40), 2000)).toBe(`0x${"00".repeat(32)}... (40 bytes)`);
  });
});

describe("processes", () => {
  test("lists the connections of this database only", async () => {
    const { root, queries } = fakeRoot();
    expect(await listProcesses(root, "acme_shop")).toEqual([{ id: 7, user: "acme_shop", command: "Query", seconds: 3, state: "executing", info: "SELECT 1" }]);
    expect(queries[0]).toContain("USER NOT IN ('root', 'event_scheduler', 'system user')");
  });

  test("only closes a connection of this database", async () => {
    const { root, queries } = fakeRoot();
    const error = await killProcess(root, "acme_shop", 99).then(() => null, (reason: Error) => reason.message);
    expect(error).toBe("That connection does not belong to this database");
    expect(queries.some((query) => query.includes("KILL"))).toBe(false);
    await killProcess(root, "acme_shop", 7);
    expect(queries.at(-1)).toBe("/* ep:kill */ KILL 7");
  });
});
