import { readdirSync, readFileSync } from "node:fs";
import type { Host } from "./host";
import { LSWS } from "./ols";

/**
 * OpenLiteSpeed reads each .htaccess once and keeps it until the next restart; LiteSpeed Enterprise notices the
 * change on its own. This imitates that: it watches the document roots that read .htaccess and, when one changes,
 * does a graceful restart. It does not cut connections, and lsphp (autoStart 2) keeps running with its OPcache.
 */

let olsQueue: Promise<unknown> = Promise.resolve();

/** Serializes whatever restarts OLS: a restart in the middle of `ols.sync` would load a configuration not yet validated. */
export function withOlsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = olsQueue.then(fn, fn);
  olsQueue = run.catch(() => undefined);
  return run;
}

/** Document roots with `autoLoadHtaccess 1`, from the vhost.conf files. Only inside /home: nothing else belongs to an account. */
export function htaccessRoots(confs: string[]): string[] {
  const roots = new Set<string>();
  for (const conf of confs) {
    if (!/^\s*autoLoadHtaccess\s+1\s*$/m.test(conf)) continue;
    const docRoot = /^docRoot\s+(.+?)\s*$/m.exec(conf)?.[1];
    if (docRoot?.startsWith("/home/") && !docRoot.includes("..")) roots.add(docRoot.replace(/\/+$/, ""));
  }
  // A subdomain inside another site's folder is already covered: inotify would add the same directories twice.
  const sorted = [...roots].sort();
  return sorted.filter((root) => !sorted.some((other) => other !== root && root.startsWith(`${other}/`)));
}

function readVhostConfs(): string[] {
  const dir = `${LSWS}/conf/vhosts`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      return [readFileSync(`${dir}/${name}/vhost.conf`, "utf8")];
    } catch {
      return [];
    }
  });
}

export interface SchedulerOptions {
  /** Waits for this much quiet: a migration uploads many .htaccess files, and they become a single restart. */
  quietMs?: number;
  /** Even if changes keep coming, nothing waits longer than this after the first one. */
  maxDelayMs?: number;
  /** Minimum time between restarts: an account touching its .htaccess in a loop cannot restart OLS nonstop. */
  minGapMs?: number;
  now?: () => number;
}

export class RestartScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingSince: number | null = null;
  private lastRestart = Number.NEGATIVE_INFINITY;
  private running = false;
  private quietMs: number;
  private maxDelayMs: number;
  private minGapMs: number;
  private now: () => number;

  constructor(private readonly restart: () => Promise<void>, options: SchedulerOptions = {}) {
    this.quietMs = options.quietMs ?? 2_000;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    this.minGapMs = options.minGapMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  /** A .htaccess changed. */
  changed(): void {
    const now = this.now();
    this.pendingSince ??= now;
    if (this.running) return;
    this.schedule(now);
  }

  /** OLS restarted for another reason: what was pending is already loaded. */
  olsRestarted(): void {
    this.lastRestart = this.now();
    if (this.running) return;
    this.pendingSince = null;
    this.clear();
  }

  get pending(): boolean {
    return this.pendingSince !== null;
  }

  stop(): void {
    this.clear();
    this.pendingSince = null;
  }

  private schedule(now: number): void {
    this.clear();
    const quiet = Math.min(this.quietMs, (this.pendingSince ?? now) + this.maxDelayMs - now);
    const gap = this.lastRestart + this.minGapMs - now;
    this.timer = setTimeout(() => void this.fire(), Math.max(quiet, gap, 0));
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async fire(): Promise<void> {
    this.timer = null;
    this.pendingSince = null;
    this.running = true;
    try {
      await this.restart();
    } catch (error) {
      console.error("[agent] restarting OLS after a .htaccess change failed:", error);
    } finally {
      this.lastRestart = this.now();
      this.running = false;
    }
    // Changes that arrived while it was restarting may not have been read: one more round.
    if (this.pendingSince !== null) this.schedule(this.now());
  }
}

const REFRESH_MS = 5 * 60_000;
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** Watches with `inotifywait`, which also adds watches for the folders created afterwards and does not follow symlinks. */
export class HtaccessWatcher {
  private roots: string[] = [];
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = MIN_BACKOFF_MS;
  readonly scheduler: RestartScheduler;

  constructor(host: Host, private readonly readConfs: () => string[] = readVhostConfs) {
    this.scheduler = new RestartScheduler(() =>
      withOlsLock(async () => {
        const { code, stderr } = await host.run(`${LSWS}/bin/lswsctrl`, ["restart"]);
        if (code !== 0) throw new Error(`lswsctrl restart failed (code ${code}): ${stderr.trim().slice(0, 200)}`);
        console.log("[agent] .htaccess changed: OpenLiteSpeed restarted gracefully");
      }),
    );
  }

  start(): void {
    this.refresh();
    setInterval(() => this.refresh(), REFRESH_MS).unref();
  }

  /** Rereads the vhosts: after `ols.sync` a site may have been created, deleted or have changed its option. */
  refresh(): void {
    const roots = htaccessRoots(this.readConfs());
    if (this.proc && roots.join("\n") === this.roots.join("\n")) return;
    this.roots = roots;
    this.respawn();
  }

  private respawn(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const previous = this.proc;
    this.proc = null;
    previous?.kill();
    if (this.roots.length === 0) return;

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(
        ["inotifywait", "-m", "-r", "-q", "-e", "close_write,moved_to,moved_from,delete,create", "--format", "%f", "--", ...this.roots],
        { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
    } catch (error) {
      console.error("[agent] could not start inotifywait (is inotify-tools installed?):", error);
      this.retryLater();
      return;
    }
    this.proc = proc;
    const startedAt = Date.now();
    void this.readEvents(proc);
    void new Response(proc.stderr as ReadableStream).text().then((text) => {
      if (text.trim()) console.error(`[agent] inotifywait: ${text.trim().slice(0, 500)}`);
    });
    void proc.exited.then((code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (Date.now() - startedAt > 60_000) this.backoffMs = MIN_BACKOFF_MS;
      console.error(`[agent] inotifywait exited with code ${code}: .htaccess files are not being watched`);
      this.retryLater();
    });
  }

  private retryLater(): void {
    this.retry = setTimeout(() => this.respawn(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private async readEvents(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      // Only the name: a file with a newline in it can at most cause one more restart, which the scheduler limits.
      if (lines.some((line) => line === ".htaccess")) this.scheduler.changed();
    }
  }
}

let active: HtaccessWatcher | null = null;

export function startHtaccessWatcher(host: Host): HtaccessWatcher {
  active = new HtaccessWatcher(host);
  active.start();
  return active;
}

/** Called by `ols.sync`. Does nothing in sandbox mode, where there is no watcher. */
export function olsSynced(restarted: boolean): void {
  if (!active) return;
  if (restarted) active.scheduler.olsRestarted();
  active.refresh();
}
