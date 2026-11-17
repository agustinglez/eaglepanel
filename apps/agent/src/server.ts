import { MAX_UPLOAD_BYTES, dbNameSchema, exportIdSchema, filePathSchema, usernameSchema } from "@eaglepanel/shared";
import { databaseExists, exportStream, rootSql, sandboxExport, storeUpload } from "./dbadmin";
import { openExport } from "./exports";
import { dispatch } from "./dispatch";
import { downloadFile, uploadFile } from "./files-runner";
import { requireManaged } from "./hosting";
import type { Host } from "./host";

/** Operations are small JSON. Only file uploads can be large, and they have their own route. */
export const MAX_OP_BYTES = 1024 * 1024;
/** What the agent HTTP server accepts: one upload plus headroom for the headers. */
export const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + MAX_OP_BYTES;

function streamParams(search: URLSearchParams): { username: string; path: string; overwrite: boolean } | null {
  const username = usernameSchema.safeParse(search.get("username"));
  const path = filePathSchema.safeParse(search.get("path"));
  const overwrite = search.get("overwrite") ?? "0";
  if (!username.success || !path.success || (overwrite !== "0" && overwrite !== "1")) return null;
  return { username: username.data, path: path.data, overwrite: overwrite === "1" };
}

const errorResponse = (error: unknown, status = 400) =>
  Response.json({ error: error instanceof Error ? error.message : "Internal error" }, { status });

export async function handle(request: Request, host: Host): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST") return new Response("Not found", { status: 404 });

  if (url.pathname === "/op") {
    // Without a declared length, request.json() would read whatever arrives: it is required and limited.
    const length = Number(request.headers.get("content-length") ?? Number.NaN);
    if (!Number.isFinite(length)) return new Response("Length required", { status: 411 });
    if (length > MAX_OP_BYTES) return new Response("Payload too large", { status: 413 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    return Response.json(await dispatch(body, host));
  }

  if (url.pathname === "/files/download" || url.pathname === "/files/upload") {
    const params = streamParams(url.searchParams);
    if (!params) return errorResponse(new Error("Invalid parameters"));
    const { username, path, overwrite } = params;
    try {
      await requireManaged(host, username);
      if (url.pathname === "/files/download") {
        const file = await downloadFile(host, username, path);
        return new Response(file.stream, {
          headers: { "content-type": "application/octet-stream", "content-length": String(file.size), "x-file-name": encodeURIComponent(file.name) },
        });
      }
      if (!request.body) return errorResponse(new Error("The content is missing"));
      if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) return errorResponse(new Error("The file exceeds the maximum"), 413);
      return Response.json(await uploadFile(host, username, path, overwrite, request.body));
    } catch (error) {
      console.error(`[agent] ${url.pathname} failed:`, error);
      return errorResponse(error);
    }
  }

  if (url.pathname === "/exports/download") {
    const id = exportIdSchema.safeParse(url.searchParams.get("id"));
    if (!id.success) return errorResponse(new Error("Invalid copy"));
    try {
      const file = await openExport(host, id.data);
      return new Response(file.stream, { headers: { "content-type": "application/gzip", "content-length": String(file.size) } });
    } catch (error) {
      return errorResponse(error, 404);
    }
  }

  // Database explorer: the dump goes out compressed as it is produced; an import is stored first, then loaded by db.import.
  if (url.pathname === "/db/export") {
    const username = usernameSchema.safeParse(url.searchParams.get("username"));
    const name = dbNameSchema.safeParse(url.searchParams.get("name"));
    const structure = url.searchParams.get("structure") ?? "0";
    if (!username.success || !name.success || (structure !== "0" && structure !== "1")) return errorResponse(new Error("Invalid parameters"));
    const database = `${username.data}_${name.data}`;
    if (host.sandbox) return new Response(sandboxExport(database, structure === "1"), { headers: { "content-type": "application/gzip" } });
    try {
      const sql = await rootSql();
      try {
        if (!(await databaseExists(sql, database))) return errorResponse(new Error("The database does not exist"), 404);
      } finally {
        await sql.close();
      }
      return new Response(exportStream(database, structure === "1"), { headers: { "content-type": "application/gzip" } });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (url.pathname === "/db/upload") {
    if (!request.body) return errorResponse(new Error("The content is missing"));
    if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) return errorResponse(new Error("The file exceeds the maximum"), 413);
    try {
      return Response.json(await storeUpload(host, request.body));
    } catch (error) {
      return errorResponse(error);
    }
  }

  return new Response("Not found", { status: 404 });
}
