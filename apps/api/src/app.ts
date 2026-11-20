import { METRICS_RANGES, systemComponent, systemComponentIdSchema, type AuditEntryDto, type JobCreatedDto, type JobDto, type MeDto, type MetricsRange } from "@eaglepanel/shared";
import { desc } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { secureHeaders } from "hono/secure-headers";
import { getConnInfo, serveStatic } from "@hono/bun";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AgentClient } from "./agent-client";
import { audit } from "./audit";
import {
  beginTotpSetup,
  consumeTotp,
  createSession,
  destroySession,
  disableTotp,
  enableTotp,
  getSessionAdmin,
  LoginThrottle,
  loginOrigin,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyCredentials,
  type Admin,
} from "./auth";
import type { Db } from "./db";
import { auditLog } from "./db/schema";
import { createHostingRoutes } from "./hosting";
import { registerDatabaseAdminRoutes } from "./database-admin";
import { registerFileRoutes } from "./files";
import { registerWebhookRoutes } from "./webhooks";
import { createEnvironmentHealth } from "./environment-health";
import { createMetricsMonitor } from "./metrics";
import { createUpdateChecker, readCurrentVersion, updateSourceFromEnv } from "./updates";
import { createPackageMonitor } from "./system-packages";
import type { JobRunner } from "./jobs";

const CSRF_HEADER = "x-eaglepanel";
/** App variables (up to 200 of 32 KB) and certificates fit comfortably. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
  totp: z.string().regex(/^\d{6}$/).optional(),
}).strict();

const totpCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const totpDisableSchema = z.object({ password: z.string().min(1).max(1024), code: z.string().regex(/^\d{6}$/) }).strict();

export interface AppDeps {
  db: Db;
  agent: AgentClient;
  jobs: JobRunner;
  /** Directory with the web build. If missing, only the API is served. */
  webDist?: string;
  /** Forces the `Secure` cookie even if the request arrives over HTTP. Over HTTPS it is always set. */
  secureCookie?: boolean;
  /** IP of this server where the panel listens: a connection from there is local (cloudflared, for example). */
  localAddresses?: readonly string[];
  /** Starts the periodic tasks (the daily backup). Real process only: tests call them by hand. */
  schedule?: boolean;
  /** JSON file with the CPU and memory history. Without it, the history is kept in memory only. */
  metricsFile?: string;
  /** Project root, where the package writes its VERSION file. */
  rootDir?: string;
}

type Env = { Variables: { admin: Admin; sessionToken: string } };

function toMe(row: Admin): MeDto {
  return { username: row.username, totpEnabled: row.totpEnabled };
}

/** How much everything local can fail together: a server process can fake `CF-Connecting-IP`. */
const LOCAL_MAX_FAILED_LOGINS = 25;

/** The connection IP. In tests (`app.request`) there is no server behind it. */
function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

export function createApp({ db, agent, jobs, webDist, secureCookie = false, localAddresses = [], schedule = false, metricsFile, rootDir }: AppDeps) {
  const throttle = new LoginThrottle();
  const localThrottle = new LoginThrottle(LOCAL_MAX_FAILED_LOGINS);
  const app = new Hono<Env>();

  app.use(secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
    },
    referrerPolicy: "no-referrer",
    // With includeSubDomains, serving the panel over HTTPS would force HTTPS on customer subdomains without a certificate.
    strictTransportSecurity: false,
  }));

  const api = new Hono<Env>();

  // A foreign site cannot send this header without going through CORS, which the panel does not enable.
  api.use(async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header(CSRF_HEADER) !== "1") {
      return c.json({ error: "Missing anti-CSRF header" }, 403);
    }
    await next();
  });

  // The server accepts large bodies for file uploads. Everything else is small JSON.
  const jsonLimit = bodyLimit({ maxSize: MAX_JSON_BYTES, onError: (c) => c.json({ error: "The request is too large" }, 413) });
  api.use(async (c, next) => (c.req.path.endsWith("/files/upload") ? next() : jsonLimit(c, next)));

  const requireAdmin = createMiddleware<Env>(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const row = token ? await getSessionAdmin(db, token) : null;
    if (!token || !row) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    c.set("admin", row);
    c.set("sessionToken", token);
    await next();
  });

  api.post("/auth/login", async (c) => {
    const { origin, local } = loginOrigin(peerAddress(c), localAddresses, c.req.header("cf-connecting-ip"));
    const fail = () => {
      throttle.recordFailure(origin);
      if (local) localThrottle.recordFailure("local");
    };
    if (throttle.isLocked(origin) || (local && localThrottle.isLocked("local"))) {
      return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    }
    const body = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "Invalid data" }, 400);
    }

    const row = await verifyCredentials(db, body.data.username, body.data.password);
    if (!row) {
      fail();
      audit(db, "login.failed", `from ${origin}`);
      return c.json({ error: "Incorrect username or password" }, 401);
    }

    if (row.totpEnabled) {
      if (!body.data.totp) {
        // Answered only after validating the password: it does not reveal whether the account uses TOTP.
        return c.json({ totpRequired: true }, 200);
      }
      if (!row.totpSecret || !consumeTotp(db, row, row.totpSecret, body.data.totp)) {
        fail();
        audit(db, "login.failed", `incorrect TOTP code, from ${origin}`);
        return c.json({ error: "Incorrect code" }, 401);
      }
    }

    throttle.reset(origin);
    const token = await createSession(db, row.id);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: secureCookie || new URL(c.req.url).protocol === "https:",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    audit(db, "login.ok");
    return c.json(toMe(row));
  });

  api.use("/*", requireAdmin);

  api.get("/auth/me", (c) => c.json(toMe(c.get("admin"))));

  api.post("/auth/logout", async (c) => {
    await destroySession(db, c.get("sessionToken"));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    audit(db, "logout");
    return c.json({ ok: true });
  });

  api.post("/auth/totp/setup", (c) => {
    const row = c.get("admin");
    if (row.totpEnabled) {
      return c.json({ error: "TOTP is already enabled" }, 409);
    }
    return c.json(beginTotpSetup(db, row));
  });

  api.post("/auth/totp/confirm", async (c) => {
    const row = c.get("admin");
    const body = totpCodeSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid code" }, 400);
    if (row.totpEnabled || !row.totpSecret) return c.json({ error: "There is no pending setup" }, 409);
    if (!consumeTotp(db, row, row.totpSecret, body.data.code)) {
      return c.json({ error: "Incorrect code" }, 400);
    }
    enableTotp(db, row);
    audit(db, "totp.enabled");
    return c.json({ ok: true });
  });

  api.post("/auth/totp/disable", async (c) => {
    const row = c.get("admin");
    const body = totpDisableSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid data" }, 400);
    const verified = await verifyCredentials(db, row.username, body.data.password);
    if (!verified || !row.totpSecret || !consumeTotp(db, row, row.totpSecret, body.data.code)) {
      audit(db, "totp.disable_failed");
      return c.json({ error: "Incorrect password or code" }, 400);
    }
    disableTotp(db, row);
    audit(db, "totp.disabled");
    return c.json({ ok: true });
  });

  api.get("/system/info", async (c) => {
    try {
      return c.json(await agent.call("system.info", {}));
    } catch (error) {
      console.error("[api] agent unavailable:", error);
      return c.json({ error: "The agent is not responding" }, 503);
    }
  });

  const metrics = createMetricsMonitor({ file: metricsFile });
  if (schedule) metrics.start();

  api.get("/system/metrics", (c) => {
    const range = c.req.query("range") ?? "1h";
    if (!(METRICS_RANGES as readonly string[]).includes(range)) return c.json({ error: "Invalid range" }, 400);
    return c.json(metrics.series(range as MetricsRange));
  });

  const updates = createUpdateChecker({
    current: rootDir ? readCurrentVersion(rootDir) : null,
    // Tests make no outside requests.
    source: schedule ? updateSourceFromEnv() : null,
  });
  if (schedule) updates.start();
  api.get("/system/update", (c) => c.json(updates.get()));
  api.post("/system/update/check", async (c) => c.json(await updates.check()));

  // System packages: versions, pending updates and known vulnerabilities. Tests make no outside requests.
  const packages = createPackageMonitor({ agent });
  if (schedule) packages.start();
  api.get("/system/packages", (c) => c.json(packages.get()));
  api.post("/system/packages/check", async (c) => c.json(await packages.check({ refresh: true, force: true })));
  api.post("/system/packages/:id/upgrade", (c) => {
    const id = systemComponentIdSchema.safeParse(c.req.param("id"));
    const def = id.success ? systemComponent(id.data) : undefined;
    if (!id.success || !def) return c.json({ error: "Unknown component" }, 404);
    if (def.packages.length === 0) return c.json({ error: "It is updated with eagle upgrade" }, 400);
    const { id: jobId, done } = jobs.enqueue({
      type: "package.upgrade",
      title: `Update ${def.name}`,
      steps: [{ name: "Install the update", run: async () => void (await agent.call("packages.upgrade", { id: id.data })) }],
    });
    // Whatever the result, the screen shows the versions as they were left.
    void done.finally(() => packages.check({ refresh: false }));
    audit(db, "package.upgrade", def.name);
    return c.json({ jobId } satisfies JobCreatedDto, 202);
  });

  const environmentHealth = createEnvironmentHealth({ db, agent });
  api.get("/environments/health", async (c) => c.json(await environmentHealth.get()));

  api.get("/jobs", (c) => c.json(jobs.list() satisfies JobDto[]));

  api.get("/jobs/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    return job ? c.json(job) : c.json({ error: "Not found" }, 404);
  });

  api.get("/jobs/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!jobs.get(id)) return c.json({ error: "Not found" }, 404);

    return streamSSE(c, async (stream) => {
      const isFinished = (job: JobDto | null) => !job || !["pending", "running"].includes(job.status);
      await new Promise<void>((resolve) => {
        // Writes are chained: otherwise the stream closes before sending the final state.
        let writes: Promise<unknown> = Promise.resolve();
        const send = (job: JobDto | null) => {
          if (job) {
            const data = JSON.stringify(job);
            writes = writes.then(() => stream.writeSSE({ event: "job", data }));
          }
          if (isFinished(job)) void writes.finally(finish);
        };
        const finish = () => {
          jobs.events.off(id, send);
          resolve();
        };
        jobs.events.on(id, send);
        stream.onAbort(finish);
        send(jobs.get(id));
      });
    });
  });

  const hosting = createHostingRoutes({ db, agent, jobs });
  api.route("/", hosting.routes);
  const files = new Hono();
  registerFileRoutes(files, { db, agent, accountExists: (username) => hosting.accountExists(username) });
  api.route("/", files);
  const databaseAdmin = new Hono();
  registerDatabaseAdminRoutes(databaseAdmin, { db, agent, jobs });
  api.route("/", databaseAdmin);
  // Outside /api: no session or anti-CSRF header. Each request is validated with the GitHub signature.
  registerWebhookRoutes(app, hosting.webhookDeps);
  // Once per process, at startup: resumes the stored deployment queue.
  hosting.resumeDeploys();
  if (schedule) hosting.backups.startScheduler();
  if (schedule) hosting.applyServerConfig();

  api.get("/audit", (c) => {
    const rows = db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(100).all();
    return c.json(rows satisfies AuditEntryDto[]);
  });

  app.route("/api", api);
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  if (webDist) {
    app.use("/*", serveStatic({ root: webDist }));
    app.get("/*", serveStatic({ path: `${webDist}/index.html` }));
  }

  return app;
}
