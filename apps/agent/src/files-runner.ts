import type { FileRequest } from "@eaglepanel/shared";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openDownload, runFileRequest, saveUpload } from "./files";
import { SandboxHost, type Host } from "./host";

const WORKER = fileURLToPath(new URL("./files-worker.ts", import.meta.url));
/** Compressing or extracting something large takes time; everything else is immediate. */
const SLOW_MS = 16 * 60 * 1000;
const FAST_MS = 2 * 60 * 1000;

export const homeOf = (username: string) => `/home/${username}`;

/**
 * How the account process is launched: its user and group, without extra groups or a way to gain privileges, and
 * with a minimal environment. No transpiler cache: it would write into the home directory.
 */
export function workerCommand(username: string, args: string[] = []): { cmd: string[]; env: Record<string, string>; cwd: string } {
  const home = homeOf(username);
  return {
    cmd: ["setpriv", `--reuid=${username}`, `--regid=${username}`, "--clear-groups", "--no-new-privs", "--", process.execPath, WORKER, ...args],
    env: { PATH: "/usr/bin:/bin", HOME: home, LC_ALL: "C.UTF-8", TMPDIR: `${home}/tmp`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    cwd: home,
  };
}

/** In sandbox mode there are no users: it operates on the equivalent directory, created if missing. */
async function sandboxHome(host: Host, username: string): Promise<string | null> {
  if (!(host instanceof SandboxHost)) return null;
  const home = host.resolvePath(homeOf(username));
  await mkdir(`${home}/public_html`, { recursive: true });
  return home;
}

async function failure(proc: { stderr: ReadableStream<Uint8Array>; exited: Promise<number> }): Promise<Error> {
  const message = (await new Response(proc.stderr).text()).trim();
  await proc.exited;
  return new Error(message.slice(0, 500) || "The file process failed");
}

export async function runFiles(host: Host, username: string, request: FileRequest): Promise<unknown> {
  const local = await sandboxHome(host, username);
  if (local) return runFileRequest(local, request);

  const { cmd, env, cwd } = workerCommand(username);
  const proc = Bun.spawn(cmd, { env, cwd, stdin: new TextEncoder().encode(JSON.stringify(request)), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), request.op === "extract" || request.op === "compress" ? SLOW_MS : FAST_MS);
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw await failure(proc);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
  }
}

/** First the size, with `stat`, so the browser shows progress; then the content. */
export async function downloadFile(host: Host, username: string, path: string): Promise<{ name: string; size: number; stream: ReadableStream<Uint8Array> }> {
  const local = await sandboxHome(host, username);
  if (local) return openDownload(local, path);

  const info = (await runFiles(host, username, { op: "stat", path })) as { name: string; type: string; size: number };
  if (info.type !== "file") throw new Error(`Not a file: ${path}`);
  const { cmd, env, cwd } = workerCommand(username, ["download", path]);
  const proc = Bun.spawn(cmd, { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  // If it fails before sending anything, the error must arrive as an error and not as an empty file.
  const reader = proc.stdout.getReader();
  const first = await reader.read();
  if (first.done && (await proc.exited) !== 0) throw await failure(proc);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!first.done) controller.enqueue(first.value);
      else controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel() {
      proc.kill();
    },
  });
  return { name: info.name, size: info.size, stream };
}

export async function uploadFile(host: Host, username: string, path: string, overwrite: boolean, body: ReadableStream<Uint8Array>): Promise<{ size: number }> {
  const local = await sandboxHome(host, username);
  if (local) return saveUpload(local, path, overwrite, body);

  const { cmd, env, cwd } = workerCommand(username, ["upload", path, overwrite ? "1" : "0"]);
  const proc = Bun.spawn(cmd, { env, cwd, stdin: body, stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw await failure(proc);
  return JSON.parse(stdout) as { size: number };
}
