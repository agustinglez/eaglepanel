import {
  MAX_UPLOAD_BYTES,
  fileRequestSchema,
  fileResultSchemas,
  filePathSchema,
  type FileRequest,
} from "@eaglepanel/shared";
import type { Hono } from "hono";
import type { AgentClient } from "./agent-client";
import { audit } from "./audit";
import type { Db } from "./db";

export interface FileRouteDeps {
  db: Db;
  agent: AgentClient;
  accountExists: (username: string) => boolean;
}

/** Anything that changes something goes to the audit log, with the paths and without content. */
function describe(request: FileRequest): string | null {
  switch (request.op) {
    case "list":
    case "stat":
    case "read":
      return null;
    case "write":
      return request.path;
    case "mkdir":
      return request.path;
    case "rename":
      return `${request.from} → ${request.to}`;
    case "copy":
    case "move":
      return `${request.paths.join(", ")} → ${request.to || "home"}`;
    case "delete":
      return request.paths.join(", ");
    case "chmod":
      return `${request.mode} ${request.paths.join(", ")}`;
    case "extract":
      return `${request.path} → ${request.to || "home"}`;
    case "compress":
      return `${request.paths.join(", ")} → ${request.name}`;
  }
}

/** Name for Content-Disposition: plain ASCII plus the full UTF-8 version. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerFileRoutes(routes: Hono, { db, agent, accountExists }: FileRouteDeps) {
  const run = async (username: string, request: FileRequest) => {
    const result = await agent.call("files.run", { username, request });
    return fileResultSchemas[request.op].parse(result);
  };
  const failed = (error: unknown) => ({ error: error instanceof Error ? error.message : "Error inesperado" });

  routes.get("/accounts/:username/files", async (c) => {
    const username = c.req.param("username");
    if (!accountExists(username)) return c.json({ error: "Not found" }, 404);
    const path = filePathSchema.safeParse(c.req.query("path") ?? "");
    if (!path.success) return c.json({ error: "Invalid path" }, 400);
    try {
      return c.json(await run(username, { op: "list", path: path.data }));
    } catch (error) {
      return c.json(failed(error), 400);
    }
  });

  routes.post("/accounts/:username/files", async (c) => {
    const username = c.req.param("username");
    if (!accountExists(username)) return c.json({ error: "Not found" }, 404);
    const request = fileRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!request.success) return c.json({ error: request.error.issues[0]?.message ?? "Invalid request" }, 400);
    try {
      const result = await run(username, request.data);
      const detail = describe(request.data);
      if (detail !== null) audit(db, `files.${request.data.op}`, `${username}: ${detail}`.slice(0, 1000));
      return c.json(result);
    } catch (error) {
      return c.json(failed(error), 400);
    }
  });

  // GET so a normal link can be used: the browser downloads with its own progress. It changes nothing.
  routes.get("/accounts/:username/files/download", async (c) => {
    const username = c.req.param("username");
    if (!accountExists(username) || !agent.stream) return c.json({ error: "Not found" }, 404);
    const path = filePathSchema.safeParse(c.req.query("path") ?? "");
    if (!path.success || path.data === "") return c.json({ error: "Invalid path" }, 400);
    const response = await agent.stream("/files/download", { username, path: path.data });
    if (!response.ok) return c.json((await response.json().catch(() => null)) ?? { error: "Download failed" }, 400);
    const name = decodeURIComponent(response.headers.get("x-file-name") ?? "archivo");
    return new Response(response.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": response.headers.get("content-length") ?? "",
        "content-disposition": disposition(name),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });

  // The body is the file as is, without multipart: it goes straight to the account process.
  routes.post("/accounts/:username/files/upload", async (c) => {
    const username = c.req.param("username");
    if (!accountExists(username) || !agent.stream) return c.json({ error: "Not found" }, 404);
    const path = filePathSchema.safeParse(c.req.query("path") ?? "");
    if (!path.success || path.data === "") return c.json({ error: "Invalid path" }, 400);
    const length = Number(c.req.header("content-length") ?? Number.NaN);
    if (!Number.isFinite(length)) return c.json({ error: "The file size is missing" }, 411);
    if (length > MAX_UPLOAD_BYTES) return c.json({ error: `Exceeds the maximum of ${MAX_UPLOAD_BYTES / 1024 / 1024 / 1024} GB per file` }, 413);
    const overwrite = c.req.query("overwrite") === "1" ? "1" : "0";
    const response = await agent.stream("/files/upload", { username, path: path.data, overwrite }, c.req.raw.body ?? new Blob([]).stream(), length);
    const body = (await response.json().catch(() => null)) as { error?: string; size?: number } | null;
    if (!response.ok) return c.json({ error: body?.error ?? "Upload failed" }, 400);
    audit(db, "files.upload", `${username}: ${path.data}`);
    return c.json({ ok: true, size: body?.size ?? length });
  });
}
