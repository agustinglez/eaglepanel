import {
  MAX_UPLOAD_BYTES,
  ROW_STATEMENTS,
  executeRequestSchema,
  firstKeyword,
  rowQuerySchema,
  tableNameSchema,
  type DbRowsDto,
  type DbStructureDto,
  type DbAccess,
  type DbProcessDto,
  type DbTableDto,
  type ExecuteResultDto,
  type JobCreatedDto,
} from "@eaglepanel/shared";
import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { AgentClient } from "./agent-client";
import { audit } from "./audit";
import type { Db } from "./db";
import { accounts, databases } from "./db/schema";
import type { JobRunner } from "./jobs";

export interface DatabaseAdminDeps {
  db: Db;
  agent: AgentClient;
  jobs: JobRunner;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "Unexpected error");

function exportName(database: string, structureOnly: boolean, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `${database}-${structureOnly ? "structure-" : ""}${stamp}.sql.gz`;
}

/**
 * Database explorer: tables, structure, rows, export and import. Every route looks the database up inside the account
 * first: a name from the URL never reaches the agent unless the panel created it for that account.
 */
export function registerDatabaseAdminRoutes(routes: Hono, { db, agent, jobs }: DatabaseAdminDeps) {
  function target(c: Context) {
    const username = c.req.param("username") ?? "";
    const database = c.req.param("database") ?? "";
    const row = db.select().from(databases).where(and(eq(databases.name, database), eq(databases.username, username))).get();
    const account = row ? db.select().from(accounts).where(eq(accounts.username, username)).get() : undefined;
    if (!row || !account || !database.startsWith(`${username}_`)) return null;
    return { username, database, name: database.slice(username.length + 1), account };
  }

  function tableParam(c: Context): string | null {
    const parsed = tableNameSchema.safeParse(c.req.param("table"));
    return parsed.success ? parsed.data : null;
  }

  const base = "/accounts/:username/databases/:database";

  routes.get(`${base}/tables`, async (c) => {
    const found = target(c);
    if (!found) return c.json({ error: "Not found" }, 404);
    try {
      const { tables } = await agent.call("db.tables", { username: found.username, name: found.name });
      return c.json(tables satisfies DbTableDto[]);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  routes.get(`${base}/tables/:table/structure`, async (c) => {
    const found = target(c);
    const table = tableParam(c);
    if (!found || table === null) return c.json({ error: "Not found" }, 404);
    try {
      return c.json(await agent.call("db.structure", { username: found.username, name: found.name, table }) satisfies DbStructureDto);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  routes.get(`${base}/tables/:table/rows`, async (c) => {
    const found = target(c);
    const table = tableParam(c);
    if (!found || table === null) return c.json({ error: "Not found" }, 404);
    const raw = c.req.query();
    // Empty fields in the URL count as absent.
    const query = rowQuerySchema.safeParse(Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== "")));
    if (!query.success) return c.json({ error: query.error.issues[0]?.message ?? "Invalid data" }, 400);
    try {
      return c.json(await agent.call("db.rows", { username: found.username, name: found.name, table, query: query.data }) satisfies DbRowsDto);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  /**
   * One statement, as a temporary MySQL user limited to this database. The account state sets what it may do: a
   * suspended account can only be read; one over its limit, read and freed, like its own user.
   */
  routes.post(`${base}/execute`, async (c) => {
    const found = target(c);
    if (!found) return c.json({ error: "Not found" }, 404);
    const body = executeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid data" }, 400);
    const access: DbAccess = found.account.suspended ? "readonly" : found.account.dbBlocked ? "blocked" : "full";
    const keyword = firstKeyword(body.data.sql);
    try {
      const result = await agent.call("db.execute", { username: found.username, name: found.name, access, request: body.data });
      // Reads are not logged: browsing would flood the activity log. Changes are, without their values.
      if (!ROW_STATEMENTS.has(keyword)) audit(db, "database.sql", `${found.database}: ${keyword || "?"}`);
      return c.json(result satisfies ExecuteResultDto);
    } catch (error) {
      if (!ROW_STATEMENTS.has(keyword)) audit(db, "database.sql", `${found.database}: ${keyword || "?"} (failed)`);
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  routes.get(`${base}/processes`, async (c) => {
    const found = target(c);
    if (!found) return c.json({ error: "Not found" }, 404);
    try {
      const { processes } = await agent.call("db.processes", { username: found.username, name: found.name });
      return c.json(processes satisfies DbProcessDto[]);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  routes.post(`${base}/processes/:id/kill`, async (c) => {
    const found = target(c);
    const id = Number(c.req.param("id"));
    if (!found || !Number.isInteger(id) || id <= 0) return c.json({ error: "Not found" }, 404);
    try {
      await agent.call("db.kill", { username: found.username, name: found.name, id });
      audit(db, "database.kill", `${found.database}: ${id}`);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  // GET so a normal link can be used: the browser downloads with its own progress. It changes nothing.
  routes.get(`${base}/export`, async (c) => {
    const found = target(c);
    if (!found || !agent.stream) return c.json({ error: "Not found" }, 404);
    const structureOnly = c.req.query("structure") === "1";
    const response = await agent.stream("/db/export", { username: found.username, name: found.name, structure: structureOnly ? "1" : "0" });
    if (!response.ok) return c.json((await response.json().catch(() => null)) ?? { error: "Export failed" }, 400);
    audit(db, "database.export", `${found.database}${structureOnly ? " (structure)" : ""}`);
    const name = exportName(found.database, structureOnly);
    return new Response(response.body, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${name}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });

  // The body is the file as is (.sql or .sql.gz). It is stored first; then a job loads it.
  routes.post(`${base}/import`, async (c) => {
    const found = target(c);
    if (!found || !agent.stream) return c.json({ error: "Not found" }, 404);
    if (found.account.suspended) return c.json({ error: "The account is suspended" }, 409);
    if (found.account.dbBlocked) return c.json({ error: "Writes on this account's databases are blocked" }, 409);
    const length = Number(c.req.header("content-length") ?? Number.NaN);
    if (!Number.isFinite(length)) return c.json({ error: "The file size is missing" }, 411);
    if (length > MAX_UPLOAD_BYTES) return c.json({ error: `Exceeds the maximum of ${MAX_UPLOAD_BYTES / 1024 / 1024 / 1024} GB per file` }, 413);
    const replace = c.req.query("replace") === "1";

    const response = await agent.stream("/db/upload", {}, c.req.raw.body ?? new Blob([]).stream(), length);
    const body = (await response.json().catch(() => null)) as { error?: string; id?: string } | null;
    if (!response.ok || !body?.id) return c.json({ error: body?.error ?? "Upload failed" }, 400);
    const upload = body.id;

    const { username, name, database } = found;
    const { id } = jobs.enqueue({
      type: "database.import",
      title: `Import into ${database}`,
      steps: [{
        name: replace ? "Empty the database and load the file" : "Load the file",
        run: async () => {
          await agent.call("db.import", { username, name, upload, replace });
        },
        // The agent already put the database back as it was; only the file may be left.
        compensate: async () => {
          await agent.call("db.discardUpload", { upload });
        },
      }],
    }, { lane: "backup" });
    audit(db, "database.import", `${database}${replace ? " (replacing it)" : ""}`);
    return c.json({ jobId: id } satisfies JobCreatedDto, 202);
  });
}
