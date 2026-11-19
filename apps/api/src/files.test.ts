import { DEFAULT_LIMITS, type AgentOpName, type FileEntry, type JobDto } from "@eaglepanel/shared";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../agent/src/dispatch";
import { SandboxHost } from "../../agent/src/host";
import { HTTPD_CONFIG } from "../../agent/src/ols";
import { handle } from "../../agent/src/server";
import type { AgentClient } from "./agent-client";
import { createApp } from "./app";
import { hashPassword, setAdminCredentials } from "./auth";
import { openDb, type Db } from "./db";
import { auditLog } from "./db/schema";
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

// The API talks to the agent in sandbox mode: operations through dispatch and streams through its HTTP server.
const agent: AgentClient = {
  call: (async (op: AgentOpName, params: unknown) => {
    if (op === "php.versions") return { versions: ["85"] };
    const response = await dispatch({ op, params }, host);
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  }) as AgentClient["call"],
  stream: (path, query, body, length) =>
    handle(new Request(`http://agent${path}?${new URLSearchParams(query)}`, {
      method: "POST", headers: length === undefined ? {} : { "content-length": String(length) }, ...(body ? { body, duplex: "half" } : {}),
    } as RequestInit), host),
};

const headers = () => ({ "content-type": "application/json", "x-eaglepanel": "1", cookie });
const post = (path: string, body: unknown) => app.request(`/api${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
const get = (path: string) => app.request(`/api${path}`, { headers: { cookie } });
const homeFile = (path: string) => readFileSync(host.resolvePath(`/home/acme/${path}`), "utf8");

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "eaglepanel-files-api-"));
  roots.push(root);
  host = new SandboxHost(root);
  db = openDb(":memory:");
  setAdminCredentials(db, "admin", passwordHash);
  jobs = new JobRunner(db);
  app = createApp({ db, agent, jobs });
  await host.writeFileAtomic(HTTPD_CONFIG, "serverName test\n");
  const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-eaglepanel": "1" }, body: JSON.stringify({ username: "admin", password: PASSWORD }) });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const created = (await (await post("/accounts", { username: "acme", limits: DEFAULT_LIMITS })).json()) as { jobId: string };
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const job = jobs.get(created.jobId) as JobDto;
    if (job.status !== "pending" && job.status !== "running") break;
    await Bun.sleep(5);
  }
});

describe("file manager", () => {
  test("creates, edits, lists and logs without the content", async () => {
    expect((await post("/accounts/acme/files", { op: "write", path: "public_html/index.php", content: "<?php echo 'hola';", mtimeMs: null })).status).toBe(200);
    const list = (await (await get("/accounts/acme/files?path=public_html")).json()) as { entries: FileEntry[] };
    expect(list.entries.map(({ name }) => name)).toEqual(["index.php"]);
    const opened = (await (await post("/accounts/acme/files", { op: "read", path: "public_html/index.php" })).json()) as { content: string; mtimeMs: number };
    expect(opened.content).toBe("<?php echo 'hola';");
    await post("/accounts/acme/files", { op: "write", path: "public_html/index.php", content: "<?php echo 'chau';", mtimeMs: opened.mtimeMs });
    expect(homeFile("public_html/index.php")).toBe("<?php echo 'chau';");

    const entries = db.select().from(auditLog).all().filter(({ action }) => action.startsWith("files."));
    expect(entries.map(({ action, detail }) => [action, detail])).toEqual([["files.write", "acme: public_html/index.php"], ["files.write", "acme: public_html/index.php"]]);
  });

  test("uploads and downloads as a stream, with the file name", async () => {
    const upload = await app.request("/api/accounts/acme/files/upload?path=public_html/foto%20año.jpg", {
      method: "POST", headers: { "x-eaglepanel": "1", cookie, "content-length": "5" }, body: "12345",
    });
    expect(await upload.json()).toEqual({ ok: true, size: 5 });
    const download = await get("/accounts/acme/files/download?path=public_html/foto%20año.jpg");
    expect(download.headers.get("content-disposition")).toBe(`attachment; filename="foto a_o.jpg"; filename*=UTF-8''foto%20a%C3%B1o.jpg`);
    expect(download.headers.get("content-length")).toBe("5");
    expect(await download.text()).toBe("12345");

    const again = await app.request("/api/accounts/acme/files/upload?path=public_html/foto%20año.jpg", {
      method: "POST", headers: { "x-eaglepanel": "1", cookie, "content-length": "1" }, body: "x",
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "Already exists: public_html/foto año.jpg" });
  });

  test("rejects paths outside the home directory, unknown accounts and requests without the anti-CSRF header", async () => {
    expect((await get("/accounts/acme/files?path=../otra")).status).toBe(400);
    expect((await post("/accounts/acme/files", { op: "read", path: "/etc/passwd" })).status).toBe(400);
    expect((await get("/accounts/nadie/files?path=")).status).toBe(404);
    const noHeader = await app.request("/api/accounts/acme/files/upload?path=a.txt", { method: "POST", headers: { cookie, "content-length": "1" }, body: "x" });
    expect(noHeader.status).toBe(403);
    const anonymous = await app.request("/api/accounts/acme/files/download?path=public_html/index.php");
    expect(anonymous.status).toBe(401);
  });

  test("system errors arrive translated into a readable message", async () => {
    const response = await post("/accounts/acme/files", { op: "delete", paths: ["does-not-exist"] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Not found: does-not-exist" });
  });

  test("other routes do not accept huge bodies", async () => {
    const big = "x".repeat(9 * 1024 * 1024);
    const response = await app.request("/api/accounts", { method: "POST", headers: { ...headers(), "content-length": String(big.length) }, body: big });
    expect(response.status).toBe(413);
  });
});
