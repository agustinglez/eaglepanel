import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { SandboxHost, type Host } from "./host";

/**
 * Downloadable copy of an account, so it can take its data (for example, when suspended): its home directory and one
 * dump per database, in a tar.gz. It contains nothing from the panel: no manifest, no FTP or MySQL hashes, no keys. It
 * lives outside the home directory (not counted in its quota) and only root can read it, until it is downloaded through the panel or expires.
 */
// Outside /var/lib/eaglepanel: that is the API directory (StateDirectory) and systemd may change the owner of
// everything in it. Copies are root-only.
export const EXPORTS_DIR = "/var/lib/eaglepanel-exports";
const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const TIMEOUT_MS = 6 * 60 * 60 * 1000;

export const exportFile = (id: string) => `${EXPORTS_DIR}/${id}.tar.gz`;

/** In sandbox mode, server paths are translated to the sandbox directory. */
const local = (host: Host, path: string) => (host instanceof SandboxHost ? host.resolvePath(path) : path);

async function run(cmd: string[], stdout?: string, sandbox = false): Promise<void> {
  // In sandbox mode (Windows), the Windows tar: the Git one takes "D:" as a remote host. On the server, just the usual paths.
  const windowsTar = sandbox && cmd[0] === "tar" && process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\tar.exe` : null;
  const binary = windowsTar && (await Bun.file(windowsTar).exists()) ? windowsTar : Bun.which(cmd[0]!, { PATH: sandbox ? (process.env.PATH ?? "") : BASE_PATH });
  if (!binary) throw new Error(`${cmd[0]} is missing on the server`);
  const proc = Bun.spawn([binary, ...cmd.slice(1)], {
    env: { PATH: BASE_PATH, HOME: "/root", LC_ALL: "C" },
    stdin: "ignore",
    stdout: stdout ? Bun.file(stdout) : "ignore",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  // tar returns 1 if a file changed while being read: the copy is still usable.
  if (code !== 0 && !(cmd[0] === "tar" && code === 1)) throw new Error(`${cmd[0]} failed: ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
}

export async function createExport(host: Host, { username, id, databases }: { username: string; id: string; databases: string[] }): Promise<{ sizeBytes: number }> {
  const dir = local(host, EXPORTS_DIR);
  const staging = `${dir}/${id}.d`;
  const part = `${dir}/${id}.tar.gz.part`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await mkdir(`${staging}/databases`, { recursive: true, mode: 0o700 });
  try {
    for (const database of databases) {
      const file = `${staging}/databases/${database}.sql`;
      if (host instanceof SandboxHost) await writeFile(file, `-- ${database} (sandbox)\n`);
      else await run(["mysqldump", "--protocol=socket", "-uroot", "--single-transaction", "--quick", "--routines", "--triggers", "--events", "--hex-blob", "--default-character-set=utf8mb4", "--set-gtid-purged=OFF", "--no-tablespaces", database], file);
    }
    const homeParent = local(host, "/home");
    // It can be missing only in sandbox mode: on the server, a missing home directory is an error and is not created as root.
    if (host instanceof SandboxHost) await mkdir(`${homeParent}/${username}`, { recursive: true });
    // As root, like the backup: tar stores links as links and does not follow them. The build cache is excluded.
    await run(["tar", "-c", "-z", "-f", part, "--one-file-system", `--exclude=${username}/.build`, "-C", staging, "databases", "-C", homeParent, username], undefined, host.sandbox);
    await chmod(part, 0o600);
    await rename(part, `${dir}/${id}.tar.gz`);
    return { sizeBytes: (await stat(`${dir}/${id}.tar.gz`)).size };
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function deleteExport(host: Host, id: string): Promise<void> {
  await rm(local(host, exportFile(id)), { force: true });
}

export async function openExport(host: Host, id: string): Promise<{ size: number; stream: ReadableStream<Uint8Array> }> {
  const path = local(host, exportFile(id));
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error("The copy no longer exists");
  return { size: file.size, stream: file.stream() };
}
