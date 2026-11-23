import type { AgentOpParams, AgentOpResult, WpExtension, WpInstall } from "@eaglepanel/shared";
import type { Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homeOf, workerCommand } from "./files-runner";
import { SandboxHost, type Host } from "./host";

const WORKER = fileURLToPath(new URL("./wordpress-worker.ts", import.meta.url));
/** WordPress reads only the first 8 KB of a file for its headers (`get_file_data`). */
const HEADER_BYTES = 8192;
/** A WordPress in a subdirectory of the document root (`/blog`, `/shop/wp`) is found up to this depth. */
const MAX_DEPTH = 2;
/** Directories visited per document root: a huge tree of uploads is not walked. */
const MAX_DIRS = 400;
const MAX_PLUGINS = 300;
const MAX_THEMES = 100;
/** PHP files of a plugin directory read looking for its header: the main file is almost always at the top. */
const MAX_PLUGIN_FILES = 40;
const WORKER_TIMEOUT_MS = 2 * 60 * 1000;
const PARALLEL_ACCOUNTS = 2;

/** Never descended into while looking for installations: they hold no WordPress of their own or are very large. */
const SKIP_DIRS = new Set(["wp-admin", "wp-includes", "wp-content", "node_modules", "vendor", ".git", ".svn", "cache", "logs", "tmp", "uploads", ".well-known", "cgi-bin"]);

async function readHead(path: string, bytes = HEADER_BYTES): Promise<string | null> {
  try {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await file.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** A header field as WordPress reads it (`get_file_data`): `Plugin Name: Foo` inside the first comment block. */
export function headerField(content: string, field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.replace(/\r/g, "\n").match(new RegExp(`^[ \\t/*#@]*${escaped}:(.*)$`, "mi"));
  return match ? match[1]!.replace(/\s*(?:\*\/|\?>).*$/, "").trim() : "";
}

/** `$wp_version = '6.8.1';` in wp-includes/version.php. */
export function parseWpVersion(content: string): string | null {
  return content.match(/\$wp_version\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
}

/** `define( 'MULTISITE', true );` in wp-config.php. */
export function isMultisite(config: string | null): boolean {
  return config ? /define\s*\(\s*['"]MULTISITE['"]\s*,\s*(true|1|'1'|"1")\s*\)/i.test(config) : false;
}

/** Hello Dolly is a single file, `hello.php`, but WordPress.org knows it as `hello-dolly`. */
const SINGLE_FILE_SLUGS: Record<string, string> = { hello: "hello-dolly" };

async function plugins(root: string): Promise<WpExtension[]> {
  const dir = `${root}/wp-content/plugins`;
  const found: WpExtension[] = [];
  for (const entry of await listDir(dir)) {
    if (found.length >= MAX_PLUGINS) break;
    if (entry.isFile() && entry.name.endsWith(".php")) {
      const head = await readHead(`${dir}/${entry.name}`);
      const name = head && headerField(head, "Plugin Name");
      if (!name) continue;
      const base = entry.name.slice(0, -4);
      found.push({ slug: SINGLE_FILE_SLUGS[base] ?? base, name, version: headerField(head, "Version") });
    } else if (entry.isDirectory()) {
      // The main file is usually named after the directory: it is read first.
      const files = (await listDir(`${dir}/${entry.name}`))
        .filter((f) => f.isFile() && f.name.endsWith(".php"))
        .map((f) => f.name)
        .sort((a, b) => Number(b === `${entry.name}.php`) - Number(a === `${entry.name}.php`) || a.localeCompare(b))
        .slice(0, MAX_PLUGIN_FILES);
      for (const file of files) {
        const head = await readHead(`${dir}/${entry.name}/${file}`);
        const name = head && headerField(head, "Plugin Name");
        if (name) {
          found.push({ slug: entry.name, name, version: headerField(head, "Version") });
          break;
        }
      }
    }
  }
  return found.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function themes(root: string): Promise<WpExtension[]> {
  const dir = `${root}/wp-content/themes`;
  const found: WpExtension[] = [];
  for (const entry of await listDir(dir)) {
    if (found.length >= MAX_THEMES) break;
    if (!entry.isDirectory()) continue;
    const head = await readHead(`${dir}/${entry.name}/style.css`);
    const name = head && headerField(head, "Theme Name");
    if (name) found.push({ slug: entry.name, name, version: headerField(head, "Version") });
  }
  return found.sort((a, b) => a.slug.localeCompare(b.slug));
}

type ScanSite = AgentOpParams<"wordpress.scan">["sites"][number];

/**
 * WordPress installations under the document roots of one account, `home` being its home directory. Symbolic links
 * are never followed (`Dirent.isDirectory()` does not resolve them). Paths in the result are relative to `home`.
 */
export async function scanAccount(home: string, sites: ScanSite[]): Promise<WpInstall[]> {
  const installs: WpInstall[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    let visited = 0;
    const walk = async (rel: string, depth: number): Promise<void> => {
      if (seen.has(rel) || visited++ >= MAX_DIRS) return;
      seen.add(rel);
      const abs = `${home}/${rel}`;
      const versionFile = await readHead(`${abs}/wp-includes/version.php`, 4096);
      const version = versionFile && parseWpVersion(versionFile);
      if (version) {
        installs.push({
          username: site.username,
          vhost: site.vhost,
          path: rel,
          version,
          multisite: isMultisite(await readHead(`${abs}/wp-config.php`, 64 * 1024)),
          plugins: await plugins(abs),
          themes: await themes(abs),
        });
        // A WordPress inside another one's directory is a rare setup: the subtree is not searched further.
        return;
      }
      if (depth >= MAX_DEPTH) return;
      for (const entry of await listDir(abs)) {
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(`${rel}/${entry.name}`, depth + 1);
      }
    };
    await walk(site.docRoot, 0);
  }
  return installs;
}

async function runWorker(username: string, sites: ScanSite[]): Promise<WpInstall[]> {
  const { cmd, env, cwd } = workerCommand(username, [], WORKER);
  const proc = Bun.spawn(cmd, { env, cwd, stdin: new TextEncoder().encode(JSON.stringify(sites)), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), WORKER_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(stderr.trim().slice(0, 300) || `The scan process exited with code ${code}`);
    return JSON.parse(stdout) as WpInstall[];
  } finally {
    clearTimeout(timer);
  }
}

async function scan({ sites }: AgentOpParams<"wordpress.scan">, host: Host): Promise<AgentOpResult<"wordpress.scan">> {
  const byAccount = new Map<string, ScanSite[]>();
  for (const site of sites) byAccount.set(site.username, [...(byAccount.get(site.username) ?? []), site]);

  const installs: WpInstall[] = [];
  const errors: { username: string; message: string }[] = [];
  const queue = [...byAccount];
  const next = async (): Promise<void> => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [username, list] = item;
      try {
        // In sandbox mode there are no users: the equivalent directory is read directly.
        const found = host instanceof SandboxHost ? await scanAccount(host.resolvePath(homeOf(username)), list) : await runWorker(username, list);
        installs.push(...found);
      } catch (error) {
        errors.push({ username, message: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_ACCOUNTS }, next));
  return { installs, errors };
}

export const wordpressHandlers = {
  "wordpress.scan": scan,
} satisfies { "wordpress.scan": (params: AgentOpParams<"wordpress.scan">, host: Host) => Promise<AgentOpResult<"wordpress.scan">> };
