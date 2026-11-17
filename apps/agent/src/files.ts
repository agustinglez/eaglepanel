import {
  MAX_EDIT_BYTES,
  MAX_LIST_ENTRIES,
  MAX_UPLOAD_BYTES,
  type FileEntry,
  type FileRequest,
  type FileResult,
} from "@eaglepanel/shared";
import { constants, type Stats } from "node:fs";
import { chmod, cp, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

/**
 * File manager operations on an account home directory. On the server they are run by `files-worker.ts`
 * as the account user: the kernel enforces its permissions and quota, and `nosymfollow` on /home prevents
 * following symlinks. Even so, this code checks that nothing leaves the home directory and that nothing is read or
 * written through a link, so as not to depend on a single barrier.
 */

/** Error to show to the panel user: the message is already meant for display. */
export class FileError extends Error {}

// They do not exist on Windows (sandbox): they are 0 and change nothing.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
// Opening a FIFO for reading waits until someone writes: with this it returns immediately.
const NONBLOCK = constants.O_NONBLOCK ?? 0;

const ERRNO: Record<string, string> = {
  ENOENT: "Not found",
  EEXIST: "Already exists",
  EACCES: "Permission denied",
  EPERM: "Permission denied",
  EDQUOT: "The account's disk quota is full",
  ENOSPC: "No space left on the disk",
  ENOTEMPTY: "The directory is not empty",
  ENOTDIR: "Not a directory",
  EISDIR: "It is a directory",
  ELOOP: "It is a symbolic link: it is not followed",
  ENAMETOOLONG: "The name is too long",
  EXDEV: "Cannot move between different disks",
  EINVAL: "Invalid operation",
};

/** Translates system errors; `where` is the relative path shown. */
export function explain(error: unknown, where = ""): Error {
  if (error instanceof FileError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  const text = code ? ERRNO[code] : undefined;
  if (text) return new FileError(where ? `${text}: ${where}` : text);
  return new FileError(error instanceof Error ? error.message : "Error inesperado");
}

/** Absolute path inside the home directory. Paths are already validated: this is the second barrier. */
function inside(home: string, path: string): string {
  const full = join(home, path);
  const rel = relative(home, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new FileError("Path outside the account");
  return full;
}

/** The directory containing `full`, already resolved, must still be inside the home directory. */
async function assertParentInside(home: string, full: string): Promise<void> {
  const [realHome, realParent] = await Promise.all([realpath(home), realpath(dirname(full))]);
  const rel = relative(realHome, realParent);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new FileError("Path outside the account");
}

/** Resolves and checks. For the home directory itself there is no containing directory to check. */
async function target(home: string, path: string): Promise<string> {
  const full = inside(home, path);
  if (path !== "") await assertParentInside(home, full);
  return full;
}

const modeOf = (st: Stats) => (st.mode & 0o777).toString(8).padStart(3, "0");

function entryOf(name: string, st: Stats): FileEntry {
  const type = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  return { name, type, size: type === "file" ? st.size : 0, mode: modeOf(st), mtimeMs: st.mtimeMs };
}

async function lstatOrNull(full: string): Promise<Stats | null> {
  try {
    return await lstat(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function requireDir(full: string, path: string): Promise<void> {
  const st = await lstat(full);
  if (st.isSymbolicLink()) throw new FileError(`It is a symbolic link: it is not followed: ${path || "home"}`);
  if (!st.isDirectory()) throw new FileError(`Not a directory: ${path}`);
}

async function requireAbsent(full: string, path: string): Promise<void> {
  if (await lstatOrNull(full)) throw new FileError(`Already exists: ${path}`);
}

/** Opens a regular file for reading, without following links or hanging on a FIFO. */
async function openRegular(full: string, path: string) {
  const handle = await open(full, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  const st = await handle.stat();
  if (!st.isFile()) {
    await handle.close();
    throw new FileError(`Not a file: ${path}`);
  }
  return { handle, st };
}

/** Copy or move target: the same name inside `to`, without overwriting anything or putting a directory inside itself. */
async function destinations(home: string, paths: string[], to: string): Promise<[string, string, string][]> {
  const dir = await target(home, to);
  await requireDir(dir, to);
  const pairs: [string, string, string][] = [];
  for (const path of paths) {
    const from = await target(home, path);
    const name = basename(path);
    const dest = join(dir, name);
    const shown = to ? `${to}/${name}` : name;
    if (to === path || to.startsWith(`${path}/`)) throw new FileError(`A directory cannot be placed inside itself: ${path}`);
    await lstat(from).catch((error) => { throw explain(error, path); });
    await requireAbsent(dest, shown);
    pairs.push([from, dest, path]);
  }
  return pairs;
}

const ARCHIVE_TIMEOUT_MS = 15 * 60 * 1000;

/** Runs zip, unzip or tar as the same user as this process. No shell. */
async function tool(command: string[], cwd: string): Promise<void> {
  const binary = Bun.which(command[0]!);
  if (!binary) throw new FileError(`${command[0]} is missing on the server`);
  const proc = Bun.spawn([binary, ...command.slice(1)], { cwd, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), ARCHIVE_TIMEOUT_MS);
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  // unzip returns 1 when there were only warnings, such as a file that already existed and was not overwritten.
  if (code === 0 || (command[0] === "unzip" && code === 1)) return;
  if (proc.signalCode) throw new FileError("The operation took too long and was stopped");
  throw new FileError(`${command[0]} failed: ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300) || `code ${code}`}`);
}

const extensionOf = { zip: ".zip", "tar.gz": ".tar.gz" } as const;

export async function runFileRequest<R extends FileRequest>(home: string, request: R): Promise<FileResult<R["op"]>> {
  return (await run(home, request)) as FileResult<R["op"]>;
}

async function run(home: string, request: FileRequest): Promise<unknown> {
  switch (request.op) {
    case "list": {
      const dir = await target(home, request.path);
      await requireDir(dir, request.path);
      const names = (await readdir(dir)).slice(0, MAX_LIST_ENTRIES + 1);
      const truncated = names.length > MAX_LIST_ENTRIES;
      const entries: FileEntry[] = [];
      for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
        // It may disappear between readdir and lstat: not an error of the directory.
        const st = await lstatOrNull(join(dir, name));
        if (st) entries.push(entryOf(name, st));
      }
      entries.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
      return { entries, truncated };
    }

    case "stat": {
      const full = await target(home, request.path);
      return entryOf(basename(full), await lstat(full));
    }

    case "read": {
      const { handle, st } = await openRegular(await target(home, request.path), request.path);
      try {
        if (st.size > MAX_EDIT_BYTES) throw new FileError(`Larger than ${MAX_EDIT_BYTES / 1024 / 1024} MB: download it to edit it`);
        const bytes = new Uint8Array(st.size);
        const { bytesRead } = await handle.read(bytes, 0, st.size, 0);
        const content = bytes.subarray(0, bytesRead);
        if (content.includes(0)) throw new FileError("It is a binary file: it cannot be edited here");
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        } catch {
          throw new FileError("It is not UTF-8 text: it cannot be edited here without corrupting it");
        }
        return { content: text, mtimeMs: st.mtimeMs, size: st.size };
      } finally {
        await handle.close();
      }
    }

    case "write": {
      const full = await target(home, request.path);
      if (request.path === "") throw new FileError("Invalid path");
      const current = await lstatOrNull(full);
      if (request.mtimeMs === null && current) throw new FileError(`Already exists: ${request.path}`);
      if (request.mtimeMs !== null) {
        if (!current) throw new FileError(`No longer exists: ${request.path}`);
        if (!current.isFile()) throw new FileError(`Not a file: ${request.path}`);
        if (current.mtimeMs !== request.mtimeMs) throw new FileError("The file changed since you opened it: open it again so those changes are not overwritten");
      }
      const mode = current ? current.mode & 0o777 : 0o644;
      await writeAtomic(full, mode, async (handle) => {
        await handle.writeFile(request.content, "utf8");
      });
      return { mtimeMs: (await stat(full)).mtimeMs };
    }

    case "mkdir": {
      const full = await target(home, request.path);
      await mkdir(full, { mode: 0o755 });
      return { ok: true };
    }

    case "rename": {
      const from = await target(home, request.from);
      const to = await target(home, request.to);
      await lstat(from).catch((error) => { throw explain(error, request.from); });
      await requireAbsent(to, request.to);
      await rename(from, to);
      return { ok: true };
    }

    case "copy": {
      for (const [from, dest, path] of await destinations(home, request.paths, request.to)) {
        // Links are copied as links: what they point to is never copied.
        await cp(from, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }).catch((error) => { throw explain(error, path); });
      }
      return { ok: true };
    }

    case "move": {
      for (const [from, dest, path] of await destinations(home, request.paths, request.to)) {
        await rename(from, dest).catch((error) => { throw explain(error, path); });
      }
      return { ok: true };
    }

    case "delete": {
      for (const path of request.paths) {
        // rm does not follow links: it deletes the link, not what it points to.
        await rm(await target(home, path), { recursive: true, force: false }).catch((error) => { throw explain(error, path); });
      }
      return { ok: true };
    }

    case "chmod": {
      const mode = Number.parseInt(request.mode, 8);
      for (const path of request.paths) {
        const full = await target(home, path);
        const st = await lstat(full).catch((error) => { throw explain(error, path); });
        // chmod on a link changes what it points to.
        if (st.isSymbolicLink()) throw new FileError(`It is a symbolic link: its permissions are not changed: ${path}`);
        await chmod(full, mode);
      }
      return { ok: true };
    }

    case "extract": {
      const archive = await target(home, request.path);
      const { handle } = await openRegular(archive, request.path);
      await handle.close();
      const dest = await target(home, request.to);
      await requireDir(dest, request.to);
      const name = request.path.toLowerCase();
      // Never overwrites what already exists. unzip discards paths with `..`; tar rejects them by default.
      if (name.endsWith(".zip")) await tool(["unzip", "-q", "-n", archive, "-d", dest], dest);
      else if (/\.(tar|tar\.gz|tgz)$/.test(name)) await tool(["tar", "-x", "-f", archive, "-C", dest, "--no-same-owner", "--no-same-permissions", "--skip-old-files"], dest);
      else throw new FileError("Unsupported format: zip, tar, tar.gz or tgz");
      return { ok: true };
    }

    case "compress": {
      const parents = new Set(request.paths.map((path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")));
      if (parents.size !== 1) throw new FileError("Everything compressed must be in the same directory");
      const parentPath = [...parents][0]!;
      const parent = await target(home, parentPath);
      const extension = extensionOf[request.format];
      const name = request.name.toLowerCase().endsWith(extension) ? request.name : `${request.name}${extension}`;
      const outPath = parentPath ? `${parentPath}/${name}` : name;
      const out = await target(home, outPath);
      await requireAbsent(out, outPath);
      const names = request.paths.map((path) => basename(path));
      for (const [index, item] of names.entries()) await lstat(join(parent, item)).catch((error) => { throw explain(error, request.paths[index]); });
      try {
        // -y stores links as links, without including what they point to.
        if (request.format === "zip") await tool(["zip", "-q", "-r", "-y", out, "--", ...names], parent);
        else await tool(["tar", "-c", "-z", "-f", out, "-C", parent, "--", ...names], parent);
      } catch (error) {
        await rm(out, { force: true });
        throw error;
      }
      return { ok: true };
    }
  }
}

/** Writes to a temporary file in the same directory and renames it: if something fails, the previous file stays intact. */
async function writeAtomic(full: string, mode: number, fill: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>): Promise<void> {
  const temp = join(dirname(full), `.${basename(full)}.eaglepanel-${crypto.randomUUID()}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    await fill(handle);
    await handle.chmod(mode);
    await handle.close();
    await rename(temp, full);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true });
    throw error;
  }
}

/** For downloads: size, name and the content as a stream. */
export async function openDownload(home: string, path: string): Promise<{ name: string; size: number; stream: ReadableStream<Uint8Array> }> {
  if (path === "") throw new FileError("Not a file");
  const { handle, st } = await openRegular(await target(home, path), path);
  // Reads from the already open descriptor (without following links) and closes it when done or if the download is cancelled.
  const close = () => handle.close().catch(() => undefined);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const buffer = new Uint8Array(256 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) {
          await close();
          controller.close();
        } else {
          controller.enqueue(buffer.subarray(0, bytesRead));
        }
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
    cancel: close,
  });
  return { name: basename(path), size: st.size, stream };
}

/**
 * Saves what arrives as `path`. It goes to a temporary file that is renamed at the end: an interrupted upload does not leave a
 * half-written file and does not overwrite the previous one.
 */
export async function saveUpload(home: string, path: string, overwrite: boolean, source: AsyncIterable<Uint8Array>): Promise<{ size: number }> {
  const full = await target(home, path);
  if (path === "") throw new FileError("Invalid path");
  const current = await lstatOrNull(full);
  if (current && !overwrite) throw new FileError(`Already exists: ${path}`);
  if (current && !current.isFile()) throw new FileError(`Already exists and is not a file: ${path}`);
  let size = 0;
  await writeAtomic(full, current ? current.mode & 0o777 : 0o644, async (handle) => {
    for await (const chunk of source) {
      size += chunk.byteLength;
      if (size > MAX_UPLOAD_BYTES) throw new FileError(`Exceeds the maximum of ${MAX_UPLOAD_BYTES / 1024 / 1024 / 1024} GB per file`);
      await handle.write(chunk);
    }
  });
  // If someone created the file meanwhile, the rename overwrote it: it only happens without overwrite and in a race of its own.
  return { size };
}
