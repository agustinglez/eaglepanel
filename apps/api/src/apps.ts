import {
  appConfigSchema,
  appReservedMemory,
  envKeySchema,
  envScopeSchema,
  envValueSchema,
  isSshRepo,
  logLinesSchema,
  type AppConfig,
  type DeploymentDto,
  type DeployRequestDto,
} from "@eaglepanel/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AgentClient } from "./agent-client";
import { audit } from "./audit";
import type { Db } from "./db";
import { accounts, appEnv, apps, deployments, deployQueue, vhosts } from "./db/schema";
import type { JobRunner, JobStep } from "./jobs";

type AccountRow = typeof accounts.$inferSelect;
type VhostRow = typeof vhosts.$inferSelect;
type AppRow = typeof apps.$inferSelect;

/** The latest releases kept on the server, to roll back without building. */
const KEEP_RELEASES = 3;
const MAX_APP_ID = 16383;
const MAX_LOG = 512 * 1024;

export interface AppRouteDeps {
  db: Db;
  agent: AgentClient;
  jobs: JobRunner;
  readBody: <S extends z.ZodType>(c: Context, schema: S) => Promise<{ data: z.infer<S> } | { error: string }>;
  startJob: (c: Context, type: string, title: string, steps: JobStep[], detail: string, secret?: string) => Response | Promise<Response>;
  accountRow: (username: string) => AccountRow | undefined;
  vhostRow: (fqdn: string) => VhostRow | undefined;
  appRow: (fqdn: string) => AppRow | undefined;
  accountApps: (username: string) => AppRow[];
  writeSite: (row: VhostRow) => Promise<void>;
  syncSites: (options?: { exclude?: string[]; restart?: boolean }) => Promise<void>;
}

const envSchema = z.object({
  vars: z.array(z.object({ key: envKeySchema, value: envValueSchema, scope: envScopeSchema }).strict()).max(200),
}).strict().refine((body) => new Set(body.vars.map(({ key }) => key)).size === body.vars.length, "There are duplicate variables");
const logsQuerySchema = z.object({ lines: z.coerce.number().pipe(logLinesSchema).default(200) });
const controlSchema = z.enum(["start", "stop", "restart"]);

const configColumns = (config: AppConfig) => ({ ...config });

export function registerAppRoutes(routes: Hono, deps: AppRouteDeps) {
  const { db, agent, jobs, readBody, startJob, accountRow, vhostRow, appRow, accountApps, writeSite, syncSites } = deps;

  /** The lowest free id: each one is a /30 network, and the space fits 16383 apps. */
  function nextAppId(): number {
    const used = new Set(db.select({ id: apps.id }).from(apps).all().map(({ id }) => id));
    for (let id = 1; id <= MAX_APP_ID; id += 1) if (!used.has(id)) return id;
    throw new Error("No app addresses left on this server");
  }

  function envFor(fqdn: string) {
    const rows = db.select().from(appEnv).where(eq(appEnv.fqdn, fqdn)).all();
    const pick = (scope: "runtime" | "build") => Object.fromEntries(rows.filter((row) => row.scope === scope || row.scope === "both").map(({ key, value }) => [key, value]));
    return { runtime: pick("runtime"), build: pick("build") };
  }

  function memoryAvailable(username: string, fqdn: string): number {
    const account = accountRow(username);
    const used = accountApps(username).filter((app) => app.fqdn !== fqdn).reduce((total, app) => total + appReservedMemory(app), 0);
    return (account?.appMemoryMb ?? 0) - used;
  }

  /** Publishes to OLS what the database says: the release of a static site or the proxy of a server. */
  async function publish(fqdn: string) {
    const current = vhostRow(fqdn);
    if (current) await writeSite(current);
    await syncSites({ restart: true });
  }

  const noProcess = (c: Context) => c.json({ error: "A static site has no process: OLS serves the published release" }, 409);

  /** For every app route: the environment must exist, be an app, and its account must not be suspended. */
  function appContext(c: Context, { allowSuspended = false } = {}) {
    const vhost = vhostRow(c.req.param("fqdn") ?? "");
    if (!vhost) return { ok: false as const, response: c.json({ error: "Not found" }, 404) };
    const app = appRow(vhost.fqdn);
    if (vhost.type !== "app" || !app) return { ok: false as const, response: c.json({ error: "The environment is not an app" }, 400) };
    if (!allowSuspended && accountRow(vhost.username)?.suspended) return { ok: false as const, response: c.json({ error: "The account is suspended" }, 409) };
    return { ok: true as const, vhost, app };
  }

  const activation = (app: AppRow, username: string, release: number) => ({
    appId: app.id, username, fqdn: app.fqdn, release,
    startCommand: app.startCommand, memoryMb: app.memoryMb, healthPath: app.healthPath, sinceMs: app.createdAt,
  });

  // -------------------------------------------------------------------------- Configure

  routes.post("/vhosts/:fqdn/app", async (c) => {
    const vhost = vhostRow(c.req.param("fqdn"));
    if (!vhost) return c.json({ error: "Not found" }, 404);
    const body = await readBody(c, appConfigSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const config = body.data;
    if (appReservedMemory(config) > memoryAvailable(vhost.username, vhost.fqdn)) {
      return c.json({ error: `The account has ${Math.max(0, memoryAvailable(vhost.username, vhost.fqdn))} MB available for apps` }, 409);
    }

    const existing = appRow(vhost.fqdn);
    if (existing) {
      const previous = { ...existing };
      if (existing.status === "deploying") return c.json({ error: "A deployment is in progress" }, 409);
      // Releases of one type do not work for the other: the environment waits for its first deployment again.
      const kindChanged = existing.kind !== config.kind;
      const steps: JobStep[] = [{
        name: "Save and prepare the runtime",
        run: async () => {
          db.update(apps).set({ ...configColumns(config), ...(kindChanged ? { status: "new" as const, currentRelease: null, commit: null } : {}) }).where(eq(apps.fqdn, vhost.fqdn)).run();
          await agent.call("app.prepare", { appId: existing.id, username: vhost.username, fqdn: vhost.fqdn, runtime: config.runtime, runtimeVersion: config.runtimeVersion });
        },
        compensate: async () => {
          db.update(apps).set(previous).where(eq(apps.fqdn, vhost.fqdn)).run();
        },
      }];
      if (kindChanged) {
        steps.push({
          name: config.kind === "static" ? "Stop the process and switch to a static site" : "Switch to server",
          run: async () => {
            if (existing.kind === "server" && existing.currentRelease) await agent.call("app.control", { appId: existing.id, action: "stop" });
            await publish(vhost.fqdn);
            await agent.call("app.prune", { appId: existing.id, username: vhost.username, fqdn: vhost.fqdn, keep: [] });
          },
          compensate: async () => {
            await publish(vhost.fqdn);
          },
        });
      } else if (config.kind === "static" && (existing.spaFallback !== config.spaFallback)) {
        steps.push({ name: "Publish the change to OLS", run: () => publish(vhost.fqdn), compensate: () => publish(vhost.fqdn) });
      }
      return startJob(c, "app.configure", `Save configuration of ${vhost.fqdn}`, steps, vhost.fqdn);
    }

    if (accountRow(vhost.username)?.suspended) return c.json({ error: "The account is suspended" }, 409);
    const id = nextAppId();
    return startJob(c, "app.create", `Convert ${vhost.fqdn} to an app`, [
      {
        name: "Register the app",
        run: async () => {
          db.transaction((tx) => {
            tx.insert(apps).values({ fqdn: vhost.fqdn, id, ...configColumns(config), status: "new", createdAt: Date.now() }).run();
            tx.update(vhosts).set({ type: "app" }).where(eq(vhosts.fqdn, vhost.fqdn)).run();
          });
        },
        compensate: async () => {
          db.transaction((tx) => {
            tx.delete(apps).where(eq(apps.fqdn, vhost.fqdn)).run();
            tx.update(vhosts).set({ type: "php" }).where(eq(vhosts.fqdn, vhost.fqdn)).run();
          });
        },
      },
      {
        name: "Prepare the image and the network",
        run: async () => {
          await agent.call("app.prepare", { appId: id, username: vhost.username, fqdn: vhost.fqdn, runtime: config.runtime, runtimeVersion: config.runtimeVersion });
          await agent.call("app.env", { appId: id, runtime: {}, build: {} });
        },
        compensate: async () => {
          await agent.call("app.remove", { appId: id, username: vhost.username, fqdn: vhost.fqdn });
        },
      },
      {
        // Until the first deployment, OLS answers 503: nothing is listening yet.
        name: "Switch the environment to proxy",
        run: async () => {
          const current = vhostRow(vhost.fqdn);
          if (current) await writeSite(current);
          await syncSites({ restart: true });
          await agent.call("php.restart", { username: vhost.username });
        },
        compensate: async () => {
          await writeSite({ ...vhost, type: "php" });
          await syncSites({ restart: true });
        },
      },
    ], `${vhost.username}: ${vhost.fqdn}`);
  });

  routes.post("/vhosts/:fqdn/app/deploy-key", async (c) => {
    const ctx = appContext(c, { allowSuspended: true });
    if (!ctx.ok) return ctx.response;
    const { publicKey } = await agent.call("app.deployKey", { appId: ctx.app.id });
    db.update(apps).set({ deployKey: publicKey }).where(eq(apps.fqdn, ctx.app.fqdn)).run();
    return c.json({ publicKey });
  });

  routes.post("/vhosts/:fqdn/to-php", (c) => {
    const ctx = appContext(c, { allowSuspended: true });
    if (!ctx.ok) return ctx.response;
    const { vhost, app } = ctx;
    return startJob(c, "app.remove", `Switch ${vhost.fqdn} to PHP`, [
      {
        name: "Stop the app and delete its releases",
        run: async () => {
          await agent.call("app.remove", { appId: app.id, username: vhost.username, fqdn: vhost.fqdn });
          db.transaction((tx) => {
            tx.delete(apps).where(eq(apps.fqdn, vhost.fqdn)).run();
            tx.update(vhosts).set({ type: "php" }).where(eq(vhosts.fqdn, vhost.fqdn)).run();
          });
        },
      },
      {
        name: "Publish the environment as PHP",
        run: async () => {
          const current = vhostRow(vhost.fqdn);
          if (current) await writeSite(current);
          await syncSites({ restart: true });
        },
      },
    ], vhost.fqdn);
  });

  // -------------------------------------------------------------------------- Variables

  routes.post("/vhosts/:fqdn/env", async (c) => {
    const ctx = appContext(c, { allowSuspended: true });
    if (!ctx.ok) return ctx.response;
    const body = await readBody(c, envSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const { app } = ctx;
    const previous = db.select().from(appEnv).where(eq(appEnv.fqdn, app.fqdn)).all();
    const replace = (rows: { key: string; value: string; scope: "runtime" | "build" | "both" }[]) => {
      db.transaction((tx) => {
        tx.delete(appEnv).where(eq(appEnv.fqdn, app.fqdn)).run();
        for (const row of rows) tx.insert(appEnv).values({ fqdn: app.fqdn, ...row }).run();
      });
    };
    // Values go neither to the audit log nor to the job name: only the keys.
    return startJob(c, "app.env", `Save variables of ${app.fqdn}`, [{
      name: "Write the variables on the server",
      run: async () => {
        replace(body.data.vars);
        await agent.call("app.env", { appId: app.id, ...envFor(app.fqdn) });
      },
      compensate: async () => {
        replace(previous.map(({ key, value, scope }) => ({ key, value, scope })));
        await agent.call("app.env", { appId: app.id, ...envFor(app.fqdn) });
      },
    }], `${app.fqdn}: ${body.data.vars.map(({ key }) => key).join(", ") || "ninguna"}`);
  });

  // -------------------------------------------------------------------------- Deploy

  routes.post("/vhosts/:fqdn/deploy", (c) => {
    const ctx = appContext(c);
    if (!ctx.ok) return ctx.response;
    const result = requestDeploy(ctx.app.fqdn, "from the panel");
    if ("error" in result) return c.json({ error: result.error }, 409);
    return c.json(result satisfies DeployRequestDto, 202);
  });

  routes.post("/vhosts/:fqdn/queue/:id/cancel", (c) => {
    const ctx = appContext(c, { allowSuspended: true });
    if (!ctx.ok) return ctx.response;
    const removed = db.delete(deployQueue)
      .where(and(eq(deployQueue.id, Number(c.req.param("id"))), eq(deployQueue.fqdn, ctx.app.fqdn))).returning().get();
    if (!removed) return c.json({ error: "That deployment already started or does not exist" }, 404);
    audit(db, "app.deploy.cancelled", `${ctx.app.fqdn} (${removed.trigger})`);
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------- Deployment queue

  /**
   * Apps with a deployment in the runner. In memory on purpose: when the panel starts there are none, and whatever
   * was left halfway is handled by `resumeDeploys`.
   */
  const deploying = new Set<string>();

  const queued = (fqdn: string) => db.select().from(deployQueue).where(eq(deployQueue.fqdn, fqdn)).orderBy(asc(deployQueue.id)).all();

  /** What prevents deploying, whether requested now or when its turn comes later. */
  function deployBlocker(fqdn: string): { vhost: VhostRow; app: AppRow } | { error: string } {
    const app = appRow(fqdn);
    const vhost = vhostRow(fqdn);
    if (!app || !vhost || vhost.type !== "app") return { error: "Not found" };
    if (accountRow(vhost.username)?.suspended) return { error: "The account is suspended" };
    if (isSshRepo(app.repoUrl) && !app.deployKey) return { error: "Generate the deploy key and add it to the repository first" };
    return { vhost, app };
  }

  /**
   * Used by the panel button and the webhook: the request enters the queue and starts if the app is not deploying.
   * Otherwise it waits for its turn: no push is lost.
   */
  function requestDeploy(fqdn: string, trigger: string, commit?: string): DeployRequestDto | { error: string } {
    const ready = deployBlocker(fqdn);
    if ("error" in ready) return ready;
    // GitHub resends the same push if it did not get a response in time: it is not built twice.
    if (commit && queued(fqdn).some((row) => row.commit === commit)) return { error: "That commit is already queued" };
    const { id } = db.insert(deployQueue).values({ fqdn, trigger, commit: commit ?? null, requestedAt: Date.now() }).returning({ id: deployQueue.id }).get()!;
    // Another one that was waiting from before may start (for example, after a restart): this one stays queued.
    const jobId = pump(fqdn);
    const position = queued(fqdn).findIndex((row) => row.id === id) + 1;
    if (jobId && position === 0) return { jobId, position: 0 };
    audit(db, "app.deploy.queued", `${fqdn} (${trigger})`);
    return { jobId: null, position };
  }

  /** Starts the next one in the queue if the app has none running. Returns the job, if one started. */
  function pump(fqdn: string): string | null {
    if (deploying.has(fqdn)) return null;
    for (;;) {
      const next = queued(fqdn)[0];
      if (!next) return null;
      db.delete(deployQueue).where(eq(deployQueue.id, next.id)).run();
      const ready = deployBlocker(fqdn);
      const plan = "error" in ready ? ready : planDeploy(ready.vhost, ready.app, next.commit ?? undefined);
      if ("error" in plan) {
        // When its turn came it was no longer possible, for example because the account was suspended: it stays in the audit log.
        audit(db, "app.deploy.dropped", `${fqdn}: ${plan.error} (${next.trigger})`);
        continue;
      }
      deploying.add(fqdn);
      db.update(apps).set({ status: "deploying" }).where(eq(apps.fqdn, fqdn)).run();
      const job = jobs.enqueue({ type: "app.deploy", title: plan.title, steps: plan.steps });
      audit(db, "app.deploy", `${plan.detail} (${next.trigger})`);
      void job.done.finally(() => {
        deploying.delete(fqdn);
        pump(fqdn);
      });
      return job.id;
    }
  }

  /**
   * When the panel starts: a deployment that was running was interrupted and its real state is unknown, so it is
   * marked as failed; then each app's queue continues.
   */
  function resumeDeploys(): void {
    const interrupted = db.select().from(deployments).where(eq(deployments.status, "running")).all();
    for (const row of interrupted) {
      db.update(deployments).set({ status: "failed", finishedAt: Date.now(), log: `${row.log}\nThe panel restarted during the deployment.\n` }).where(eq(deployments.id, row.id)).run();
    }
    for (const app of db.select().from(apps).where(eq(apps.status, "deploying")).all()) {
      db.update(apps).set({ status: app.currentRelease ? "online" : "failed" }).where(eq(apps.fqdn, app.fqdn)).run();
    }
    for (const fqdn of new Set(db.select({ fqdn: deployQueue.fqdn }).from(deployQueue).all().map((row) => row.fqdn))) pump(fqdn);
  }

  /**
   * The steps of a deployment. Built when its turn comes, with the configuration at that moment. Returns an
   * error if it cannot, without side effects: the deployment record is created by its first step.
   */
  function planDeploy(vhost: VhostRow, app: AppRow, wanted?: string): { title: string; detail: string; steps: JobStep[] } | { error: string } {

    const last = db.select({ release: deployments.release }).from(deployments).where(eq(deployments.fqdn, app.fqdn)).orderBy(desc(deployments.release)).limit(1).get();
    const release = (last?.release ?? 0) + 1;
    const username = vhost.username;
    const before = { status: app.status, currentRelease: app.currentRelease };
    let deploymentId = 0;
    let log = "";
    let commit = "";

    const append = (text: string) => {
      log = `${log}${text}`.slice(-MAX_LOG);
      db.update(deployments).set({ log }).where(eq(deployments.id, deploymentId)).run();
    };
    const steps: JobStep[] = [
      {
        name: "Register the deployment",
        run: async () => {
          deploymentId = db.insert(deployments).values({ fqdn: app.fqdn, release, kind: app.kind, status: "running", startedAt: Date.now() }).returning({ id: deployments.id }).get()!.id;
          db.update(apps).set({ status: "deploying" }).where(eq(apps.fqdn, app.fqdn)).run();
        },
        // Also runs if a later step failed: it leaves the record and the status consistent.
        compensate: async () => {
          if (deploymentId) db.update(deployments).set({ status: "failed", finishedAt: Date.now() }).where(eq(deployments.id, deploymentId)).run();
          // If there was an active release, the start step compensation already brought it back up.
          db.update(apps).set({ status: before.currentRelease ? before.status : "failed" }).where(eq(apps.fqdn, app.fqdn)).run();
        },
      },
      {
        name: "Prepare the image and the variables",
        run: async () => {
          const current = appRow(app.fqdn) ?? app;
          await agent.call("app.prepare", { appId: current.id, username, fqdn: current.fqdn, runtime: current.runtime, runtimeVersion: current.runtimeVersion });
          await agent.call("app.env", { appId: current.id, ...envFor(current.fqdn) });
        },
      },
      {
        name: "Fetch the code",
        run: async () => {
          const current = appRow(app.fqdn) ?? app;
          append(`$ git fetch ${current.repoUrl} ${current.branch}\n`);
          const fetched = await agent.call("app.fetch", { appId: current.id, repoUrl: current.repoUrl, branch: current.branch, ...(wanted ? { commit: wanted } : {}) });
          commit = fetched.commit;
          db.update(deployments).set({ commit: fetched.commit, message: fetched.message }).where(eq(deployments.id, deploymentId)).run();
          append(`${fetched.commit.slice(0, 12)} ${fetched.message}\n`);
          await agent.call("app.unpack", { appId: current.id, username, fqdn: current.fqdn, commit: fetched.commit, subdir: current.subdir });
        },
      },
    ];
    if (app.buildCommand.trim()) {
      steps.push({
        name: "Build",
        run: async () => {
          const current = appRow(app.fqdn) ?? app;
          append(`\n$ ${current.buildCommand}\n`);
          const result = await agent.call("app.build", { appId: current.id, username, fqdn: current.fqdn, command: current.buildCommand, runtime: current.runtime, runtimeVersion: current.runtimeVersion });
          append(result.log);
          if (result.code !== 0) throw new Error(`The build exited with code ${result.code}. Check the deployment log.`);
        },
      });
    }
    steps.push({
      name: app.kind === "static" ? "Save the published files" : "Build the release image",
      run: async () => {
        const current = appRow(app.fqdn) ?? app;
        const saved = await agent.call("app.release", {
          appId: current.id, username, fqdn: current.fqdn, release, kind: app.kind, outputDir: current.outputDir, runtime: current.runtime, runtimeVersion: current.runtimeVersion,
        });
        const size = `${(saved.bytes / 1048576).toFixed(1)} MB`;
        append(app.kind === "static" ? `\n${saved.files} files published (${size}).\n` : `\nRelease ${release} image: ${size}.\n`);
      },
    });
    if (app.kind === "static") {
      steps.push({
        // The OLS change is a graceful restart: in-flight requests finish with the previous release.
        name: "Publish the release",
        run: async () => {
          db.update(apps).set({ currentRelease: release }).where(eq(apps.fqdn, app.fqdn)).run();
          await publish(app.fqdn);
          append("Publicada.\n");
        },
        compensate: async () => {
          db.update(apps).set({ currentRelease: before.currentRelease }).where(eq(apps.fqdn, app.fqdn)).run();
          await publish(app.fqdn);
        },
      });
    }
    if (app.kind === "server") steps.push(
      {
        name: "Start and check that it responds",
        run: async () => {
          const current = appRow(app.fqdn) ?? app;
          append(`\n$ ${current.startCommand}\n`);
          const result = await agent.call("app.activate", activation(current, username, release));
          if (!result.healthy) {
            append(result.log);
            throw new Error(`The app did not respond at ${current.healthPath}. Check the deployment log.`);
          }
          append("Responde. Publicada.\n");
        },
        // Rolls back to the previous release if there was one: the site must not stay down because of a failed deployment.
        compensate: async () => {
          const current = appRow(app.fqdn) ?? app;
          if (before.currentRelease) {
            const back = await agent.call("app.activate", activation(current, username, before.currentRelease));
            append(back.healthy ? `\nRolled back to release ${before.currentRelease}.\n` : `\nRelease ${before.currentRelease} did not respond either.\n`);
          } else {
            await agent.call("app.control", { appId: current.id, action: "stop" });
          }
        },
      },
    );
    steps.push({
      name: `Keep the last ${KEEP_RELEASES} releases`,
      run: async () => {
        db.update(deployments).set({ status: "succeeded", finishedAt: Date.now() }).where(eq(deployments.id, deploymentId)).run();
        db.update(apps).set({ status: "online", currentRelease: release, commit }).where(eq(apps.fqdn, app.fqdn)).run();
        await agent.call("app.prune", { appId: app.id, username, fqdn: app.fqdn, keep: keptReleases(app.fqdn) });
      },
    });
    return { title: `Deploy ${app.fqdn}`, detail: `${app.fqdn}: release ${release}`, steps };
  }

  /** The latest releases that built successfully, of the current type, always including the active one. */
  function keptReleases(fqdn: string): number[] {
    const row = appRow(fqdn);
    const current = row?.currentRelease;
    const recent = db.select({ release: deployments.release }).from(deployments)
      .where(and(eq(deployments.fqdn, fqdn), eq(deployments.status, "succeeded"), eq(deployments.kind, row?.kind ?? "server")))
      .orderBy(desc(deployments.release)).limit(KEEP_RELEASES).all().map(({ release }) => release);
    return [...new Set([...recent, ...(current ? [current] : [])])];
  }

  routes.get("/vhosts/:fqdn/deployments", (c) => {
    const ctx = appContext(c, { allowSuspended: true });
    if (!ctx.ok) return ctx.response;
    const kept = new Set(keptReleases(ctx.app.fqdn));
    const rows = db.select({
      id: deployments.id, release: deployments.release, commit: deployments.commit, message: deployments.message,
      status: deployments.status, startedAt: deployments.startedAt, finishedAt: deployments.finishedAt,
    }).from(deployments).where(eq(deployments.fqdn, ctx.app.fqdn)).orderBy(desc(deployments.id)).limit(50).all();
    return c.json(rows.map((row) => ({
      ...row,
      available: row.status === "succeeded" && kept.has(row.release),
      active: row.release === ctx.app.currentRelease && row.status === "succeeded",
    })) satisfies DeploymentDto[]);
  });

  routes.get("/vhosts/:fqdn/deployments/:id/log", (c) => {
    const ctx = appContext(c, { allowSuspended: true });
    if (!ctx.ok) return ctx.response;
    const row = db.select({ log: deployments.log }).from(deployments)
      .where(and(eq(deployments.id, Number(c.req.param("id"))), eq(deployments.fqdn, ctx.app.fqdn))).get();
    return row ? c.json(row) : c.json({ error: "Not found" }, 404);
  });

  routes.post("/vhosts/:fqdn/deployments/:id/rollback", (c) => {
    const ctx = appContext(c);
    if (!ctx.ok) return ctx.response;
    const { vhost, app } = ctx;
    const target = db.select().from(deployments).where(and(eq(deployments.id, Number(c.req.param("id"))), eq(deployments.fqdn, app.fqdn))).get();
    if (!target || target.status !== "succeeded" || !keptReleases(app.fqdn).includes(target.release)) {
      return c.json({ error: "That release is no longer on the server" }, 409);
    }
    if (target.release === app.currentRelease) return c.json({ error: "It is already the active release" }, 409);
    const previous = app.currentRelease;
    if (app.kind === "static") {
      return startJob(c, "app.rollback", `Roll back ${app.fqdn} to release ${target.release}`, [{
        name: "Publish the release",
        run: async () => {
          db.update(apps).set({ status: "online", currentRelease: target.release, commit: target.commit }).where(eq(apps.fqdn, app.fqdn)).run();
          await publish(app.fqdn);
        },
        compensate: async () => {
          db.update(apps).set({ status: app.status, currentRelease: previous, commit: app.commit }).where(eq(apps.fqdn, app.fqdn)).run();
          await publish(app.fqdn);
        },
      }], `${app.fqdn}: release ${target.release}`);
    }
    return startJob(c, "app.rollback", `Roll back ${app.fqdn} to release ${target.release}`, [{
      name: "Activate the release and check that it responds",
      run: async () => {
        const result = await agent.call("app.activate", activation(app, vhost.username, target.release));
        if (!result.healthy) throw new Error("That release did not respond");
        db.update(apps).set({ status: "online", currentRelease: target.release, commit: target.commit }).where(eq(apps.fqdn, app.fqdn)).run();
      },
      compensate: async () => {
        if (previous) await agent.call("app.activate", activation(app, vhost.username, previous));
      },
    }], `${app.fqdn}: release ${target.release}`);
  });

  // -------------------------------------------------------------------------- Operate

  routes.post("/vhosts/:fqdn/app/:action", (c) => {
    const action = controlSchema.safeParse(c.req.param("action"));
    if (!action.success) return c.json({ error: "Not found" }, 404);
    const ctx = appContext(c, { allowSuspended: action.data === "stop" });
    if (!ctx.ok) return ctx.response;
    const { app } = ctx;
    if (app.kind === "static") return noProcess(c);
    if (!app.currentRelease) return c.json({ error: "The app has not been deployed yet" }, 409);
    const titles = { start: `Start ${app.fqdn}`, stop: `Stop ${app.fqdn}`, restart: `Restart ${app.fqdn}` } as const;
    const steps = { start: "Start the app", stop: "Stop the app", restart: "Restart the app" } as const;
    return startJob(c, `app.${action.data}`, titles[action.data], [{
      name: steps[action.data],
      run: async () => {
        await agent.call("app.control", { appId: app.id, action: action.data });
        db.update(apps).set({ status: action.data === "stop" ? "stopped" : "online" }).where(eq(apps.fqdn, app.fqdn)).run();
      },
    }], app.fqdn);
  });

  routes.get("/vhosts/:fqdn/app/status", async (c) => {
    const ctx = appContext(c, { allowSuspended: true });
    if (!ctx.ok) return ctx.response;
    if (ctx.app.kind === "static") return noProcess(c);
    try {
      return c.json(await agent.call("app.status", { appId: ctx.app.id }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The agent is not responding" }, 502);
    }
  });

  routes.get("/vhosts/:fqdn/app/logs", async (c) => {
    const ctx = appContext(c, { allowSuspended: true });
    if (!ctx.ok) return ctx.response;
    if (ctx.app.kind === "static") return noProcess(c);
    const query = logsQuerySchema.safeParse({ lines: c.req.query("lines") ?? undefined });
    if (!query.success) return c.json({ error: "Invalid query" }, 400);
    try {
      return c.json(await agent.call("app.logs", { appId: ctx.app.id, lines: query.data.lines, sinceMs: ctx.app.createdAt }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The agent is not responding" }, 502);
    }
  });

  // -------------------------------------------------------------------------- Webhook

  const webhookSchema = z.object({ enabled: z.boolean() }).strict();

  /** Enabling generates a new secret; enabling again replaces it, and the previous one stops working. */
  routes.post("/vhosts/:fqdn/webhook", async (c) => {
    const ctx = appContext(c, { allowSuspended: true });
    if (!ctx.ok) return ctx.response;
    const body = await readBody(c, webhookSchema);
    if ("error" in body) return c.json({ error: body.error }, 400);
    const secret = body.data.enabled ? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url") : null;
    db.update(apps).set({ webhookSecret: secret }).where(eq(apps.fqdn, ctx.app.fqdn)).run();
    audit(db, body.data.enabled ? "app.webhook.enabled" : "app.webhook.disabled", ctx.app.fqdn);
    return c.json({ ok: true });
  });

  return { appRow, requestDeploy, resumeDeploys, queued };
}

