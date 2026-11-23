import { DEFAULT_LIMITS, type AgentOpName, type AuditEntryDto, type DbProcessDto, type ExecuteResultDto, type DbRowsDto, type DbStructureDto, type DbTableDto, type JobDto } from "@eaglepanel/shared";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPORT_DIR } from "../../agent/src/dbadmin";
import { dispatch } from "../../agent/src/dispatch";
import { SandboxHost } from "../../agent/src/host";
import { HTTPD_CONFIG } from "../../agent/src/ols";
import { handle } from "../../agent/src/server";
import type { AgentClient } from "./agent-client";
import { createApp } from "./app";
import { hashPassword, setAdminCredentials } from "./auth";
import { openDb, type Db } from "./db";
import { accounts } from "./db/schema";
import { JobRunner } from "./jobs";

const PASSWORD = "test-password-value";
const passwordHash = await hashPassword(PASSWORD);
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let host: SandboxHost;
let db: Db;
let jobs: JobRunner;
let app: ReturnType<typeof createApp>;
let cookie: string;
let calls: AgentOpName[];
let lastParams: Partial<Record<AgentOpName, unknown>>;

// The agent handlers in sandbox mode, including its streaming routes, without going through the network.
const agent: AgentClient = {
  call: (async (op: AgentOpName, params: unknown) => {
    calls.push(op);
    lastParams[op] = params;
    if (op === "php.versions") return { versions: ["85"] };
    const response = await dispatch({ op, params }, host);
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  }) as AgentClient["call"],
  stream: (path, query, body, length) => handle(new Request(`http://agent${path}?${new URLSearchParams(query)}`, {
    method: "POST",
    headers: length === undefined ? {} : { "content-length": String(length) },
    ...(body ? { body, duplex: "half" } : {}),
  } as RequestInit), host),
};

const headers = () => ({ "x-eaglepanel": "1", cookie });
const get = (path: string) => app.request(`/api${path}`, { headers: { cookie } });
const post = (path: string, body: unknown) => app.request(`/api${path}`, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify(body) });
const upload = (path: string, content: string | Uint8Array) => {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return app.request(`/api${path}`, { method: "POST", headers: { ...headers(), "content-length": String(bytes.byteLength) }, body: bytes });
};

async function waitJob(jobId: string): Promise<JobDto> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const job = jobs.get(jobId);
    if (job && job.status !== "pending" && job.status !== "running") return job;
    await Bun.sleep(5);
  }
  throw new Error("The job did not finish");
}

async function runJob(response: Response): Promise<JobDto> {
  expect(response.status).toBe(202);
  return waitJob(((await response.json()) as { jobId: string }).jobId);
}

const BASE = "/accounts/acme/databases/acme_shop";

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "eaglepanel-dbadmin-"));
  roots.push(root);
  host = new SandboxHost(root);
  calls = [];
  lastParams = {};
  db = openDb(":memory:");
  setAdminCredentials(db, "admin", passwordHash);
  jobs = new JobRunner(db);
  app = createApp({ db, agent, jobs });
  await host.writeFileAtomic(HTTPD_CONFIG, "serverName test\n\nlistener Default{\n  address 127.0.0.1:8088\n}\n");
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-eaglepanel": "1" },
    body: JSON.stringify({ username: "admin", password: PASSWORD }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  for (const username of ["acme", "other"]) {
    expect((await runJob(await post("/accounts", { username, limits: DEFAULT_LIMITS }))).status).toBe("succeeded");
  }
  expect((await runJob(await post("/accounts/acme/databases", { name: "shop" }))).status).toBe("succeeded");
  expect((await runJob(await post("/accounts/other/databases", { name: "data" }))).status).toBe("succeeded");
});

describe("browse", () => {
  test("tables, structure and rows of an account database", async () => {
    const tables = (await (await get(`${BASE}/tables`)).json()) as DbTableDto[];
    expect(tables.map((table) => table.name)).toEqual(["posts", "settings", "published_posts"]);
    const structure = (await (await get(`${BASE}/tables/posts/structure`)).json()) as DbStructureDto;
    expect(structure.columns.map((column) => column.name)).toEqual(["id", "title", "body", "published_at"]);
    const rows = (await (await get(`${BASE}/tables/posts/rows?page=1&size=25&sort=id&dir=desc&column=title&op=contains&value=`)).json()) as DbRowsDto;
    expect(rows.rows).toHaveLength(3);
    expect(rows.total).toBe(3);
  });

  test("a database of another account, or one the panel did not create, is not found", async () => {
    for (const path of [
      "/accounts/acme/databases/other_data/tables",
      "/accounts/other/databases/acme_shop/tables",
      "/accounts/acme/databases/acme_nope/tables",
      "/accounts/acme/databases/mysql/tables",
    ]) {
      expect((await get(path)).status).toBe(404);
    }
    expect(calls).not.toContain("db.tables");
  });

  test.each([
    ["size=33"],
    ["page=0"],
    ["dir=sideways"],
    ["op=drop"],
    ["unknown=1"],
  ])("rejects the query %s", async (query) => {
    expect((await get(`${BASE}/tables/posts/rows?${query}`)).status).toBe(400);
    expect(calls).not.toContain("db.rows");
  });

  test("a table that does not exist is an error, not a query", async () => {
    const response = await get(`${BASE}/tables/${encodeURIComponent("posts`; DROP TABLE posts")}/rows`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("Table not found");
  });
});

describe("export", () => {
  test("downloads a compressed dump", async () => {
    const response = await get(`${BASE}/export?structure=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="acme_shop-structure-\d{8}-\d{4}\.sql\.gz"$/);
    const text = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer())));
    expect(text).toContain("acme_shop");
    expect(text).not.toContain("INSERT");
  });
});

describe("import", () => {
  test("uploads the file and loads it in a job", async () => {
    const job = await runJob(await upload(`${BASE}/import?replace=1`, Bun.gzipSync(new TextEncoder().encode("CREATE TABLE t (id int);\n"))));
    expect(job.status).toBe("succeeded");
    expect(job.title).toBe("Import into acme_shop");
    expect(calls).toContain("db.import");
    // The upload is deleted once loaded.
    expect(readdirSync(host.resolvePath(IMPORT_DIR))).toEqual([]);
  });

  test("accepts files over the JSON body limit", async () => {
    const big = `INSERT INTO t VALUES ('${"x".repeat(10 * 1024 * 1024)}');\n`;
    const job = await runJob(await upload(`${BASE}/import`, big));
    expect(job.status).toBe("succeeded");
  });

  test("rejects files that are not SQL", async () => {
    const response = await upload(`${BASE}/import`, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("It is not a SQL file");
    expect(calls).not.toContain("db.import");
  });

  test("not on a suspended or blocked account", async () => {
    db.update(accounts).set({ suspended: true }).where(eq(accounts.username, "acme")).run();
    expect((await upload(`${BASE}/import`, "SELECT 1;\n")).status).toBe(409);
    db.update(accounts).set({ suspended: false, dbBlocked: true }).where(eq(accounts.username, "acme")).run();
    expect((await upload(`${BASE}/import`, "SELECT 1;\n")).status).toBe(409);
    expect(calls).not.toContain("db.import");
  });

  test("not into a database of another account", async () => {
    expect((await upload("/accounts/acme/databases/other_data/import", "SELECT 1;\n")).status).toBe(404);
  });
});

describe("SQL console", () => {
  const run = (sql: string, params: (string | null)[] = []) => post(`${BASE}/execute`, { sql, params });

  test("a read answers with rows and is not logged", async () => {
    const result = (await (await run("SELECT * FROM posts")).json()) as ExecuteResultDto;
    expect(result).toMatchObject({ kind: "rows", columns: ["id", "title", "body", "published_at"] });
    const audit = (await (await get("/audit")).json()) as AuditEntryDto[];
    expect(audit.some((entry) => entry.action === "database.sql")).toBe(false);
  });

  test("a change is logged with its keyword, not its values", async () => {
    const result = (await (await run("UPDATE posts SET title = ? WHERE id = ?", ["secret title", "1"])).json()) as ExecuteResultDto;
    expect(result).toMatchObject({ kind: "done", affectedRows: 1 });
    const audit = (await (await get("/audit")).json()) as AuditEntryDto[];
    const entry = audit.find((item) => item.action === "database.sql");
    expect(entry?.detail).toBe("acme_shop: UPDATE");
  });

  test("the account state sets what the temporary user may do", async () => {
    await run("SELECT 1");
    expect(lastParams["db.execute"]).toMatchObject({ access: "full" });
    db.update(accounts).set({ dbBlocked: true }).where(eq(accounts.username, "acme")).run();
    await run("SELECT 1");
    expect(lastParams["db.execute"]).toMatchObject({ access: "blocked" });
    db.update(accounts).set({ suspended: true }).where(eq(accounts.username, "acme")).run();
    await run("SELECT 1");
    expect(lastParams["db.execute"]).toMatchObject({ access: "readonly" });
  });

  test.each([
    [{ sql: "" }],
    [{ sql: "   " }],
    [{ sql: "SELECT 1", extra: true }],
    [{ sql: "x".repeat(200_001) }],
  ])("rejects %#", async (body) => {
    expect((await post(`${BASE}/execute`, body)).status).toBe(400);
    expect(calls).not.toContain("db.execute");
  });

  test("not on a database of another account", async () => {
    expect((await post("/accounts/acme/databases/other_data/execute", { sql: "SELECT 1" })).status).toBe(404);
    expect(calls).not.toContain("db.execute");
  });
});

describe("processes", () => {
  test("lists and closes connections of the database", async () => {
    const list = (await (await get(`${BASE}/processes`)).json()) as DbProcessDto[];
    expect(list.map((item) => item.id)).toEqual([41]);
    expect((await post(`${BASE}/processes/41/kill`, {})).status).toBe(200);
    expect((await post(`${BASE}/processes/99/kill`, {})).status).toBe(400);
    expect((await post(`${BASE}/processes/abc/kill`, {})).status).toBe(404);
  });
});
