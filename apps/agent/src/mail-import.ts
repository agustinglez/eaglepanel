import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join, posix } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { zstdDecompressSync } from "node:zlib";
import type { Host } from "./host";
import { SandboxHost } from "./host";

/**
 * Bringing mail from another server into a mailbox here: from a cPanel backup (its Maildir folders, read from disk) or
 * by IMAP from the old server. Either way the messages enter through JMAP as the mailbox itself, with the
 * administrator acting for it (Stalwart's `address%admin` login, verified in WSL): no password of the mailbox is
 * needed or changed. Running it again skips what is already there (same Message-ID, or same date and size).
 */

/** Extracted backups and their metadata: root's, outside /var/lib/eaglepanel (the API's StateDirectory). */
export const IMPORTS_DIR = "/var/lib/eaglepanel-imports";
export const importDir = (id: string) => `${IMPORTS_DIR}/${id}`;
const importMeta = (id: string) => `${IMPORTS_DIR}/${id}.json`;
const MAIL_ADMIN_FILE = "/etc/eaglepanel/mail-admin";
const JMAP_BASE = "http://127.0.0.1:8480";
/** Each call stops after this and returns where it got to: the API calls again until it is done. */
const BUDGET_MS = 150_000;
const BATCH_MESSAGES = 40;
const BATCH_BYTES = 20 * 1024 * 1024;
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** In sandbox mode, server paths go to the sandbox directory. */
const local = (host: Host, path: string) => (host instanceof SandboxHost ? host.resolvePath(path) : path);

// ---------------------------------------------------------------------------- Folders

export interface SourceFolder {
  /** Folder names from the top; [] is the inbox. */
  path: string[];
  /** JMAP role of a special folder (sent, drafts, trash, junk, archive): it goes into the one that already exists. */
  role: string | null;
}

export interface SourceMessage {
  raw: Uint8Array;
  keywords: string[];
  receivedAt: Date;
}

/** IMAP folder names travel in modified UTF-7 (RFC 3501): `Env&AO0-ados` is `Enviados`. */
export function decodeMutf7(name: string): string {
  return name.replace(/&([^-]*)-/g, (_match, encoded: string) => {
    if (encoded === "") return "&";
    const bytes = Buffer.from(encoded.replace(/,/g, "/"), "base64");
    let text = "";
    for (let index = 0; index + 1 < bytes.length; index += 2) text += String.fromCharCode((bytes[index]! << 8) | bytes[index + 1]!);
    return text;
  });
}

const ROLE_BY_NAME: Record<string, string> = {
  sent: "sent", "sent items": "sent", "sent messages": "sent", "sent mail": "sent", enviados: "sent",
  drafts: "drafts", draft: "drafts", borradores: "drafts",
  trash: "trash", "deleted items": "trash", "deleted messages": "trash", papelera: "trash",
  junk: "junk", spam: "junk", "junk mail": "junk", "junk e-mail": "junk",
  archive: "archive", archives: "archive", archivo: "archive",
};
const ROLE_BY_FLAG: Record<string, string> = { "\\sent": "sent", "\\drafts": "drafts", "\\trash": "trash", "\\junk": "junk", "\\archive": "archive" };

/** Special-use flags first (IMAP), then the usual names, only at the top level. */
export function roleOf(path: string[], flags: string[] = []): string | null {
  for (const flag of flags) {
    const role = ROLE_BY_FLAG[flag.toLowerCase()];
    if (role) return role;
  }
  return path.length === 1 ? (ROLE_BY_NAME[path[0]!.toLowerCase()] ?? null) : null;
}

/** Splits an IMAP or Maildir++ name; cPanel puts everything under INBOX (`INBOX.Sent`), which is dropped. */
export function folderPath(name: string, delimiter: string | null): string[] {
  const segments = (delimiter ? name.split(delimiter) : [name]).map(decodeMutf7).filter((segment) => segment !== "");
  if (segments[0]?.toUpperCase() === "INBOX") segments.shift();
  return segments;
}

// ---------------------------------------------------------------------------- Maildir (cPanel)

/** Maildir++ as Dovecot keeps it in cPanel: the inbox at the root, every other folder in `.Name` or `.Parent.Child`. */
export async function maildirFolders(root: string): Promise<(SourceFolder & { dir: string })[]> {
  const folders: (SourceFolder & { dir: string })[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => entry.isDirectory() && (entry.name === "cur" || entry.name === "new"))) folders.push({ path: [], role: null, dir: root });
  for (const entry of entries) {
    // Dirent does not follow links: a link is neither a directory nor a file here.
    if (!entry.isDirectory() || !entry.name.startsWith(".") || entry.name === "." || entry.name === "..") continue;
    const path = folderPath(entry.name.slice(1), ".");
    if (path.length === 0) continue;
    folders.push({ path, role: roleOf(path), dir: join(root, entry.name) });
  }
  return folders.sort((a, b) => (a.path.length === 0 ? -1 : b.path.length === 0 ? 1 : a.path.join("/").localeCompare(b.path.join("/"))));
}

const MAILDIR_FLAGS: Record<string, string> = { S: "$seen", F: "$flagged", R: "$answered", D: "$draft", P: "$forwarded" };

export interface MaildirMessage {
  file: string;
  keywords: string[];
  size: number;
  mtime: Date;
}

/** Its messages in a fixed order (by file name), without the ones marked deleted (T) and without links. */
export async function maildirMessages(dir: string): Promise<MaildirMessage[]> {
  const messages: MaildirMessage[] = [];
  for (const sub of ["cur", "new"]) {
    const entries = await readdir(join(dir, sub), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // ":2," on the server; cPanel backups write "_2," (a ":" is not allowed everywhere), and some systems "!2,".
      const flags = /[:!_]2,([A-Za-z]*)$/.exec(entry.name)?.[1] ?? "";
      if (flags.includes("T")) continue;
      const file = join(dir, sub, entry.name);
      const info = await lstat(file);
      if (!info.isFile()) continue;
      // Dovecot may keep each message compressed: S= in the name is its real size.
      const realSize = Number(/,S=(\d+)/.exec(entry.name)?.[1] ?? Number.NaN);
      const size = Number.isSafeInteger(realSize) ? realSize : info.size;
      messages.push({ file, keywords: [...flags].map((flag) => MAILDIR_FLAGS[flag]).filter((value): value is string => !!value), size, mtime: info.mtime });
    }
  }
  return messages.sort((a, b) => basename(a.file).localeCompare(basename(b.file)));
}

/**
 * A message as it was received. Dovecot's zlib plugin (on in cPanel servers like Banahosting's) keeps each one
 * compressed, recognized by its first bytes: gzip and zstd here, bzip2 and xz with their tools.
 */
export async function readMaildirMessage(file: string): Promise<Uint8Array> {
  const data = new Uint8Array(await readFile(file));
  return decompressMessage(data, file);
}

export async function decompressMessage(data: Uint8Array, label = "a message"): Promise<Uint8Array> {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  if (starts(0x1f, 0x8b)) return Bun.gunzipSync(new Uint8Array(data));
  if (starts(0x28, 0xb5, 0x2f, 0xfd)) return new Uint8Array(zstdDecompressSync(data));
  const tool = starts(0x42, 0x5a, 0x68) ? "bzip2" : starts(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) ? "xz" : null;
  if (tool) {
    const proc = Bun.spawn([tool, "-dc"], { stdin: data, stdout: "pipe", stderr: "pipe" });
    const [output, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
    if (code !== 0) throw new Error(`${basename(label)} could not be decompressed with ${tool}`);
    return new Uint8Array(output);
  }
  if (starts(0x5a, 0x4c, 0xff, 0x4c, 0x5a, 0x34)) throw new Error(`${basename(label)} is compressed with Dovecot's lz4, which cannot be read here`);
  return data;
}

/** Mailbox names, password hashes and quotas from `etc/<domain>/` of the backup. */
export function parseCpanelEtc(shadow: string | null, quota: string | null): Map<string, { hash: string | null; quotaBytes: number | null }> {
  const result = new Map<string, { hash: string | null; quotaBytes: number | null }>();
  for (const line of (shadow ?? "").split("\n")) {
    const [name, hash] = line.trim().split(":");
    if (!name || !LOCAL_PART.test(name)) continue;
    // SHA-512, SHA-256, bcrypt or MD5 crypt: Stalwart checks them as they are (SHA-512 verified in WSL).
    result.set(name, { hash: hash && /^\$(6|5|1|2[aby])\$[./A-Za-z0-9$]+$/.test(hash) ? hash : null, quotaBytes: null });
  }
  for (const line of (quota ?? "").split("\n")) {
    const [name, bytes] = line.trim().split(":");
    if (!name || !LOCAL_PART.test(name) || !bytes || !/^\d+$/.test(bytes)) continue;
    const entry = result.get(name) ?? { hash: null, quotaBytes: null };
    entry.quotaBytes = Number(bytes) > 0 ? Number(bytes) : null;
    result.set(name, entry);
  }
  return result;
}

/**
 * Finds `mail/<domain>` and `etc/<domain>` in an extracted backup or a home directory, without following links. They
 * are usually side by side; when they came in separate files they may not be, and `etc` is looked for on its own.
 */
export async function locateDomainMail(root: string, domain: string, maxDepth = 6): Promise<{ mail: string; etc: string | null } | null> {
  const found = await locateDir(root, domain, "mail", maxDepth);
  if (!found || found.etc) return found;
  return { mail: found.mail, etc: (await locateDir(root, domain, "etc", maxDepth))?.mail ?? null };
}

const isDir = async (path: string) => (await lstat(path).catch(() => null))?.isDirectory() ?? false;

/** `kind/<domain>` (mail or etc), with the other one next to it if it is there. */
async function locateDir(root: string, domain: string, kind: "mail" | "etc", maxDepth: number): Promise<{ mail: string; etc: string | null } | null> {
  const sibling = async (parent: string) => {
    if (kind === "etc") return null;
    const etc = join(parent, "etc", domain);
    return (await isDir(etc)) ? etc : null;
  };
  if (basename(root) === domain && basename(dirname(root)) === kind) return { mail: root, etc: await sibling(dirname(dirname(root))) };
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      // Just the folder uploaded on its own: mail/<domain> without the rest of the home.
      if (basename(dir) === kind && (await isDir(join(dir, domain)))) return { mail: join(dir, domain), etc: await sibling(dirname(dir)) };
      const candidate = join(dir, kind, domain);
      if (await isDir(candidate)) return { mail: candidate, etc: await sibling(dir) };
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && !["cur", "new", "tmp", "public_html", "node_modules"].includes(entry.name)) next.push(join(dir, entry.name));
      }
    }
    level = next.slice(0, 2000);
  }
  return null;
}

export interface ScannedMailbox {
  name: string;
  messages: number;
  bytes: number;
  quotaBytes: number | null;
  passwordHash: boolean;
}

interface ImportMeta {
  domain: string;
  mail: string;
  etc: string | null;
}

/** Uploaded through the panel: a backup, or the mail and etc folders, as .tar.gz, .tgz, .tar or .zip. */
export const UPLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(tar\.gz|tgz|tar|zip)$/i;
const MAX_UPLOAD_TOTAL = 100 * 1024 * 1024 * 1024;
/** Uploads and extracted copies nobody imported: gone after two days. */
const STALE_MS = 2 * 24 * 3600 * 1000;
const uploadsDir = (id: string) => `${importDir(id)}/uploads`;

/**
 * One piece of an upload, appended at `offset`: the browser sends big files in pieces, so there is no size limit per
 * request and an interrupted piece is sent again from where the file is.
 */
export async function appendUpload(host: Host, importId: string, name: string, offset: number, body: ReadableStream<Uint8Array>): Promise<{ size: number }> {
  if (!UPLOAD_NAME.test(name)) throw new Error("Upload a .tar.gz, .tgz, .tar or .zip file");
  const root = local(host, IMPORTS_DIR);
  await mkdir(root, { recursive: true, mode: 0o711 });
  if (offset === 0) await removeStale(host);
  const dir = local(host, uploadsDir(importId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  const current = (await lstat(path).catch(() => null))?.size ?? 0;
  if (current !== offset) throw new Error(`The upload of ${name} is at ${current} bytes, not ${offset}: send from there`);
  const file = await open(path, "a", 0o600);
  let size = current;
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > MAX_UPLOAD_TOTAL) throw new Error("The file is too big");
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
  return { size };
}

async function removeStale(host: Host): Promise<void> {
  const root = local(host, IMPORTS_DIR);
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    const info = await lstat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > STALE_MS) await rm(path, { recursive: true, force: true });
  }
}

/** Only the mail of that domain: other files of the backup are never extracted. */
async function extractArchive(host: Host, username: string, archive: string, staging: string, domain: string): Promise<void> {
  // By its first bytes (PK), not its name: a zip renamed .tar.gz is still a zip.
  const head = new Uint8Array(await Bun.file(local(host, archive)).slice(0, 2).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) {
    // Exit 11: none of the patterns is in it (for example etc.zip when looking for mail): not an error here.
    const result = await host.run("runuser", ["-u", username, "--", "unzip", "-qq", "-o", archive, `*mail/${domain}/*`, `*etc/${domain}/*`, "-d", staging]);
    if (result.code !== 0 && result.code !== 1 && result.code !== 11) throw new Error(`The zip could not be read: ${result.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
    return;
  }
  const tar = async (file: string, into: string) => {
    // As the account itself: a crafted archive can only write what its owner could.
    const result = await host.run("runuser", ["-u", username, "--", "tar", "-xf", file, "-C", into, "--no-same-owner", "--no-same-permissions",
      "--wildcards", `*mail/${domain}/*`, `*etc/${domain}/*`, "*homedir.tar"]);
    // A pattern that matches nothing is an error for tar: it is not one here.
    const real = result.stderr.split("\n").filter((line) => line.trim() && !/Not found in archive|Exiting with failure status due to previous errors/.test(line));
    if (result.code !== 0 && real.length > 0) throw new Error(`The backup could not be read: ${real.slice(-2).join(" ").slice(0, 300)}`);
  };
  await tar(archive, staging);
  // Account transfers (pkgacct) keep the home directory in a tar of its own.
  const inner = await findFile(staging, "homedir.tar", 3);
  if (inner) {
    await tar(inner, dirname(inner));
    await rm(inner, { force: true });
  }
}

async function findFile(root: string, name: string, depth: number): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) return join(root, entry.name);
  }
  if (depth === 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(join(root, entry.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

/** A path the account gave, inside its home directory. */
export function homePath(username: string, relativePath: string): string {
  const home = `/home/${username}`;
  // Server paths: POSIX also when the tests run on Windows.
  const clean = posix.normalize(`${home}/${relativePath.replace(/^\/+/, "")}`);
  if (clean !== home && !clean.startsWith(`${home}/`)) throw new Error("The path has to be inside the account's home directory");
  return clean;
}

/**
 * Reads the mail of `domain` from the files uploaded for `importId` (`path` undefined), or from a file or folder at
 * `path` in the account. Archives are extracted by the account's own user, into a copy that only root and it can read.
 */
export async function scanBackup(host: Host, { username, path, domain, importId }: { username: string; path?: string; domain: string; importId: string }): Promise<ScannedMailbox[]> {
  await mkdir(local(host, IMPORTS_DIR), { recursive: true, mode: 0o711 });
  const extracted = `${importDir(importId)}/extracted`;
  const prepare = async () => {
    await rm(local(host, extracted), { recursive: true, force: true });
    await mkdir(local(host, extracted), { recursive: true, mode: 0o700 });
    await host.run("chown", ["-R", `${username}:${username}`, importDir(importId)]);
  };

  let root: string;
  let label: string;
  if (path === undefined) {
    label = "the uploaded files";
    const names = (await readdir(local(host, uploadsDir(importId))).catch(() => [] as string[])).filter((name) => UPLOAD_NAME.test(name)).sort();
    if (names.length === 0) throw new Error("Nothing was uploaded");
    await prepare();
    for (const name of names) await extractArchive(host, username, `${uploadsDir(importId)}/${name}`, extracted, domain);
    root = local(host, extracted);
  } else {
    label = path;
    const source = local(host, homePath(username, path));
    const info = await lstat(source).catch(() => null);
    if (!info) throw new Error(`${path} does not exist in the account`);
    if (info.isSymbolicLink()) throw new Error(`${path} is a link: give the real file or folder`);
    if (info.isFile()) {
      await prepare();
      await extractArchive(host, username, homePath(username, path), extracted, domain);
      root = local(host, extracted);
    } else if (info.isDirectory()) {
      root = source;
    } else {
      throw new Error(`${path} is neither a backup file nor a folder`);
    }
  }

  const found = await locateDomainMail(root, domain);
  if (!found) throw new Error(`No mail of ${domain} was found in ${label} (it looks for mail/${domain} inside)`);
  const etc = parseCpanelEtc(
    found.etc ? await readFile(join(found.etc, "shadow"), "utf8").catch(() => null) : null,
    found.etc ? await readFile(join(found.etc, "quota"), "utf8").catch(() => null) : null,
  );
  const mailboxes: ScannedMailbox[] = [];
  for (const entry of await readdir(found.mail, { withFileTypes: true })) {
    if (!entry.isDirectory() || !LOCAL_PART.test(entry.name) || entry.name.includes("..")) continue;
    let messages = 0;
    let bytes = 0;
    for (const folder of await maildirFolders(join(found.mail, entry.name))) {
      for (const message of await maildirMessages(folder.dir)) {
        messages += 1;
        bytes += message.size;
      }
    }
    const extra = etc.get(entry.name);
    mailboxes.push({ name: entry.name, messages, bytes, quotaBytes: extra?.quotaBytes ?? null, passwordHash: !!extra?.hash });
  }
  const meta: ImportMeta = { domain, mail: found.mail, etc: found.etc };
  await writeFile(local(host, importMeta(importId)), JSON.stringify(meta), { mode: 0o600 });
  return mailboxes.sort((a, b) => a.name.localeCompare(b.name));
}

async function readMeta(host: Host, importId: string, domain: string): Promise<ImportMeta> {
  const text = await readFile(local(host, importMeta(importId)), "utf8").catch(() => null);
  if (!text) throw new Error("That backup is no longer here: look for its mailboxes again");
  const meta = JSON.parse(text) as ImportMeta;
  if (meta.domain !== domain) throw new Error("That backup was read for another domain");
  return meta;
}

/** The cPanel password hash of a mailbox, if the backup has it. */
export async function backupPasswordHash(host: Host, importId: string, domain: string, name: string): Promise<string | null> {
  const meta = await readMeta(host, importId, domain);
  if (!meta.etc) return null;
  const shadow = await readFile(join(meta.etc, "shadow"), "utf8").catch(() => null);
  return parseCpanelEtc(shadow, null).get(name)?.hash ?? null;
}

export async function discardImport(host: Host, importId: string): Promise<void> {
  await rm(local(host, importDir(importId)), { recursive: true, force: true });
  await rm(local(host, importMeta(importId)), { force: true });
}

// ---------------------------------------------------------------------------- IMAP (another server)

type Token = string | Buffer | null | Token[];

/** IMAP response data: atoms, quoted strings, literals and lists. A literal comes as a marker \0n\0 in the text. */
export function parseTokens(text: string, literals: Buffer[]): Token[] {
  let index = 0;
  function list(closing: string | null): Token[] {
    const items: Token[] = [];
    while (index < text.length) {
      const char = text[index]!;
      if (char === " ") { index += 1; continue; }
      if (closing && char === closing) { index += 1; return items; }
      if (char === "(") { index += 1; items.push(list(")")); continue; }
      if (char === "\u0000") {
        const end = text.indexOf("\u0000", index + 1);
        items.push(literals[Number(text.slice(index + 1, end))]!);
        index = end + 1;
        continue;
      }
      if (char === "\"") {
        let value = "";
        index += 1;
        while (index < text.length && text[index] !== "\"") {
          if (text[index] === "\\") index += 1;
          value += text[index] ?? "";
          index += 1;
        }
        index += 1;
        items.push(value);
        continue;
      }
      let atom = "";
      let depth = 0;
      while (index < text.length) {
        const c = text[index]!;
        if (c === "[") depth += 1;
        if (c === "]") depth -= 1;
        if (depth === 0 && (c === " " || c === "(" || c === ")")) break;
        atom += c;
        index += 1;
      }
      items.push(atom.toUpperCase() === "NIL" ? null : atom);
    }
    return items;
  }
  return list(null);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** `17-Jul-1996 02:44:25 -0700` */
export function parseInternalDate(value: string): Date | null {
  const match = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  const month = MONTHS.indexOf(match[2]!.toLowerCase());
  if (month === -1) return null;
  const offset = (Number(match[8]) * 60 + Number(match[9])) * (match[7] === "-" ? -1 : 1);
  return new Date(Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6])) - offset * 60_000);
}

const IMAP_FLAGS: Record<string, string> = { "\\seen": "$seen", "\\flagged": "$flagged", "\\answered": "$answered", "\\draft": "$draft", $forwarded: "$forwarded" };

interface ImapLine {
  text: string;
  literals: Buffer[];
}

/** Just what the copy needs: login, folders, and reading messages without marking them as read. */
export class ImapClient {
  private buffer = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private closed: Error | null = null;
  private tag = 0;

  private constructor(private readonly socket: TLSSocket | import("node:net").Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake?.();
    });
    const end = (error?: Error) => {
      this.closed ??= error ?? new Error("The other server closed the connection");
      this.wake?.();
    };
    socket.on("error", end);
    socket.on("close", () => end());
    socket.setTimeout(60_000, () => socket.destroy(new Error("The other server stopped answering")));
  }

  static async connect({ host, port, verify, socket }: { host: string; port: number; verify: boolean; socket?: import("node:net").Socket }): Promise<ImapClient> {
    const connection = socket ?? await new Promise<TLSSocket>((resolve, reject) => {
      const tls = tlsConnect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: verify }, () => resolve(tls));
      tls.once("error", (error: Error & { code?: string }) => reject(new Error(
        /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|altnames/i.test(`${error.code ?? ""} ${error.message}`)
          ? `The certificate of ${host} was not accepted (${error.message}). Use the name in its certificate, or turn off the certificate check.`
          : `Could not connect to ${host}:${port}: ${error.message}`,
      )));
    });
    const client = new ImapClient(connection);
    const greeting = await client.readLine();
    if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) throw new Error(`${host} did not greet as an IMAP server`);
    return client;
  }

  private async fill(bytes: number): Promise<void> {
    while (this.buffer.length < bytes) {
      if (this.closed) throw this.closed;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }

  private async rawLine(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end !== -1) {
        const line = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 2);
        return line;
      }
      await this.fill(this.buffer.length + 1);
    }
  }

  async readLine(): Promise<ImapLine> {
    let text = "";
    const literals: Buffer[] = [];
    for (;;) {
      const part = await this.rawLine();
      const literal = /\{(\d+)\+?\}$/.exec(part);
      if (!literal) return { text: text + part, literals };
      const size = Number(literal[1]);
      await this.fill(size);
      literals.push(Buffer.from(this.buffer.subarray(0, size)));
      this.buffer = this.buffer.subarray(size);
      text += `${part.slice(0, literal.index)}\u0000${literals.length - 1}\u0000`;
    }
  }

  async command(command: string): Promise<ImapLine[]> {
    const tag = `E${++this.tag}`;
    this.socket.write(`${tag} ${command}\r\n`);
    const untagged: ImapLine[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.text.startsWith(`${tag} `)) {
        const status = line.text.slice(tag.length + 1);
        if (!/^OK/i.test(status)) throw new Error(status.replace(/^(NO|BAD)\s*/i, "").trim() || status);
        return untagged;
      }
      untagged.push(line);
    }
  }

  async login(user: string, password: string): Promise<void> {
    if (/[\r\n]/.test(user + password)) throw new Error("The user or password has a line break");
    const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
    try {
      await this.command(`LOGIN ${quote(user)} ${quote(password)}`);
    } catch (error) {
      throw new Error(`The other server rejected the user or password: ${error instanceof Error ? error.message : error}`);
    }
  }

  async folders(): Promise<(SourceFolder & { name: string })[]> {
    const folders: (SourceFolder & { name: string })[] = [];
    for (const line of await this.command("LIST \"\" \"*\"")) {
      const match = /^\* LIST (.*)$/i.exec(line.text);
      if (!match) continue;
      const [flags, delimiter, name] = parseTokens(match[1]!, line.literals);
      const flagList = (Array.isArray(flags) ? flags : []).map(String);
      if (flagList.some((flag) => /^\\(noselect|nonexistent)$/i.test(flag))) continue;
      const raw = Buffer.isBuffer(name) ? name.toString("utf8") : String(name ?? "");
      const path = folderPath(raw, typeof delimiter === "string" ? delimiter : null);
      folders.push({ name: raw, path, role: roleOf(path, flagList) });
    }
    return folders.sort((a, b) => (a.path.length === 0 ? -1 : b.path.length === 0 ? 1 : a.path.join("/").localeCompare(b.path.join("/"))));
  }

  /** Messages after `afterUid`, oldest first, without their content. */
  async list(folder: string, afterUid: number): Promise<{ uid: number; keywords: string[]; deleted: boolean; receivedAt: Date | null; size: number }[]> {
    await this.command(`EXAMINE ${quoteMailbox(folder)}`);
    const rows: { uid: number; keywords: string[]; deleted: boolean; receivedAt: Date | null; size: number }[] = [];
    for (const line of await this.command(`UID FETCH ${afterUid + 1}:* (UID FLAGS INTERNALDATE RFC822.SIZE)`)) {
      const fields = fetchFields(line);
      if (!fields) continue;
      const uid = Number(fields.UID);
      // n:* always returns the last message, even if its UID is lower.
      if (!(uid > afterUid)) continue;
      const flags = (Array.isArray(fields.FLAGS) ? fields.FLAGS : []).map((flag) => String(flag).toLowerCase());
      rows.push({
        uid,
        keywords: flags.map((flag) => IMAP_FLAGS[flag]).filter((value): value is string => !!value),
        deleted: flags.includes("\\deleted"),
        receivedAt: typeof fields.INTERNALDATE === "string" ? parseInternalDate(fields.INTERNALDATE) : null,
        size: Number(fields["RFC822.SIZE"] ?? 0),
      });
    }
    return rows.sort((a, b) => a.uid - b.uid);
  }

  async bodies(uids: number[]): Promise<Map<number, Buffer>> {
    const result = new Map<number, Buffer>();
    for (const line of await this.command(`UID FETCH ${uids.join(",")} (UID BODY.PEEK[])`)) {
      const fields = fetchFields(line);
      if (!fields) continue;
      const body = fields["BODY[]"];
      if (Buffer.isBuffer(body)) result.set(Number(fields.UID), body);
      else if (typeof body === "string") result.set(Number(fields.UID), Buffer.from(body));
    }
    return result;
  }

  async close(): Promise<void> {
    try {
      if (!this.closed) await this.command("LOGOUT");
    } catch {
      // It was leaving anyway.
    }
    this.socket.destroy();
  }
}

function quoteMailbox(name: string): string {
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function fetchFields(line: ImapLine): Record<string, Token> | null {
  const match = /^\* \d+ FETCH (.*)$/i.exec(line.text);
  if (!match) return null;
  const [list] = parseTokens(match[1]!, line.literals);
  if (!Array.isArray(list)) return null;
  const fields: Record<string, Token> = {};
  for (let index = 0; index + 1 < list.length; index += 2) fields[String(list[index]).toUpperCase()] = list[index + 1]!;
  return fields;
}

// ---------------------------------------------------------------------------- JMAP, as the mailbox

/** `<id@host>` → `id@host`, as JMAP returns it. */
export function messageIdOf(raw: Uint8Array): string | null {
  const head = Buffer.from(raw.subarray(0, Math.min(raw.length, 65_536))).toString("latin1");
  const end = head.search(/\r?\n\r?\n/);
  const headers = end === -1 ? head : head.slice(0, end);
  const match = /^message-id:[ \t]*(.*(?:\r?\n[ \t].*)*)/im.exec(headers);
  const value = match?.[1]?.replace(/\s+/g, "").replace(/^<|>$/g, "");
  return value || null;
}

const dedupeKey = (messageId: string | null, receivedAt: Date, size: number) =>
  messageId ? `id:${messageId}` : `at:${Math.floor(receivedAt.getTime() / 1000)}:${size}`;

interface Mailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
}

export interface MailboxSink {
  maxUpload: number;
  mailboxFor(folder: SourceFolder): Promise<string>;
  existing(mailboxId: string): Promise<Set<string>>;
  add(mailboxId: string, messages: SourceMessage[]): Promise<number>;
}

export async function jmapSink(host: Host, address: string, fetcher: typeof fetch = fetch): Promise<MailboxSink> {
  const pair = (await host.readFile(MAIL_ADMIN_FILE))?.trim();
  if (!pair?.includes(":")) throw new Error("Mail is not installed on this server");
  const separator = pair.indexOf(":");
  // Stalwart lets the administrator act for a mailbox: `mailbox%admin` with the administrator's password.
  const auth = `Basic ${Buffer.from(`${address}%${pair.slice(0, separator)}:${pair.slice(separator + 1)}`).toString("base64")}`;
  const sessionResponse = await fetcher(`${JMAP_BASE}/jmap/session`, { headers: { authorization: auth } });
  if (!sessionResponse.ok) throw new Error(`The mail server did not open ${address} (${sessionResponse.status})`);
  const session = (await sessionResponse.json()) as { primaryAccounts: Record<string, string>; capabilities: Record<string, Record<string, number>> };
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
  if (!accountId) throw new Error(`${address} has no mail account`);
  const core = session.capabilities["urn:ietf:params:jmap:core"] ?? {};
  const maxGet = Math.min(core.maxObjectsInGet ?? 500, 500);
  const using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetcher(`${JMAP_BASE}/jmap`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ using, methodCalls: [[name, { accountId, ...args }, "c"]] }),
    });
    if (!response.ok) throw new Error(`The mail server answered ${response.status} to ${name}`);
    const [entry] = ((await response.json()) as { methodResponses: [string, Record<string, unknown>, string][] }).methodResponses;
    if (!entry || entry[0] === "error") throw new Error(`${name}: ${String(entry?.[1]?.description ?? entry?.[1]?.type ?? "error")}`);
    return entry[1];
  }

  let mailboxes = ((await call("Mailbox/get", { ids: null, properties: ["name", "parentId", "role"] })).list as Mailbox[]) ?? [];

  return {
    maxUpload: core.maxSizeUpload ?? 50_000_000,

    async mailboxFor(folder) {
      if (folder.path.length === 0) return mailboxes.find((box) => box.role === "inbox")!.id;
      if (folder.role) {
        const special = mailboxes.find((box) => box.role === folder.role);
        if (special) return special.id;
      }
      let parentId: string | null = null;
      for (const name of folder.path) {
        const found = mailboxes.find((box) => box.parentId === parentId && box.name.toLowerCase() === name.toLowerCase());
        if (found) {
          parentId = found.id;
          continue;
        }
        const created = await call("Mailbox/set", { create: { m: { name, parentId } } });
        const id = (created.created as Record<string, { id: string }> | undefined)?.m?.id;
        if (!id) throw new Error(`The folder ${folder.path.join("/")} could not be created: ${JSON.stringify(created.notCreated ?? {}).slice(0, 200)}`);
        mailboxes = [...mailboxes, { id, name, parentId, role: null }];
        parentId = id;
      }
      return parentId!;
    },

    async existing(mailboxId) {
      const keys = new Set<string>();
      for (let position = 0; ; position += maxGet) {
        const ids = ((await call("Email/query", { filter: { inMailbox: mailboxId }, position, limit: maxGet })).ids as string[]) ?? [];
        if (ids.length === 0) break;
        const list = ((await call("Email/get", { ids, properties: ["messageId", "receivedAt", "size"] })).list as { messageId: string[] | null; receivedAt: string; size: number }[]) ?? [];
        for (const email of list) keys.add(dedupeKey(email.messageId?.[0] ?? null, new Date(email.receivedAt), email.size));
        if (ids.length < maxGet) break;
      }
      return keys;
    },

    async add(mailboxId, messages) {
      const emails: Record<string, unknown> = {};
      for (const [index, message] of messages.entries()) {
        const upload = await fetcher(`${JMAP_BASE}/jmap/upload/${accountId}/`, { method: "POST", headers: { authorization: auth, "content-type": "message/rfc822" }, body: message.raw });
        if (!upload.ok) throw new Error(`The mail server did not take a message (${upload.status})`);
        const { blobId } = (await upload.json()) as { blobId: string };
        emails[String(index)] = {
          blobId,
          mailboxIds: { [mailboxId]: true },
          keywords: Object.fromEntries(message.keywords.map((keyword) => [keyword, true])),
          receivedAt: message.receivedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
        };
      }
      const result = await call("Email/import", { emails });
      const failed = Object.values((result.notCreated as Record<string, { type: string; description?: string }> | undefined) ?? {});
      const quota = failed.find((error) => /quota/i.test(`${error.type} ${error.description ?? ""}`));
      if (quota) throw new Error("The mailbox ran out of space: raise its quota and run the import again (it continues where it stopped)");
      if (failed.length > 0) throw new Error(`The mail server rejected ${failed.length} message(s): ${failed[0]!.description ?? failed[0]!.type}`);
      return Object.keys((result.created as Record<string, unknown> | undefined) ?? {}).length;
    },
  };
}

// ---------------------------------------------------------------------------- The copy

export interface ImportCursor {
  folder: number;
  /** Backup: messages done in that folder. IMAP: the last UID copied. */
  position: number;
}

export interface ImportProgress {
  done: boolean;
  cursor: ImportCursor;
  imported: number;
  skipped: number;
}

/** A folder at a time, in batches, until the time is up. The cursor says where to go on. */
async function copyFolders<T>(
  sink: MailboxSink,
  folders: SourceFolder[],
  cursor: ImportCursor,
  pending: (folderIndex: number, position: number) => Promise<T[]>,
  info: (item: T) => { size: number; receivedAt: Date; keywords: string[]; position: number },
  load: (items: T[]) => Promise<Map<T, Uint8Array>>,
  deadline: number,
): Promise<ImportProgress> {
  let imported = 0;
  let skipped = 0;
  for (let folderIndex = cursor.folder; folderIndex < folders.length; folderIndex += 1) {
    const position = folderIndex === cursor.folder ? cursor.position : 0;
    const items = await pending(folderIndex, position);
    if (items.length === 0) continue;
    const mailboxId = await sink.mailboxFor(folders[folderIndex]!);
    const known = await sink.existing(mailboxId);
    for (let start = 0; start < items.length;) {
      const batch: T[] = [];
      let bytes = 0;
      while (start + batch.length < items.length && batch.length < BATCH_MESSAGES && (batch.length === 0 || bytes < BATCH_BYTES)) {
        const item = items[start + batch.length]!;
        bytes += info(item).size;
        batch.push(item);
      }
      const contents = await load(batch.filter((item) => info(item).size <= sink.maxUpload));
      const messages: SourceMessage[] = [];
      for (const item of batch) {
        const raw = contents.get(item);
        const meta = info(item);
        if (!raw) { skipped += 1; continue; }
        const key = dedupeKey(messageIdOf(raw), meta.receivedAt, raw.length);
        if (known.has(key)) { skipped += 1; continue; }
        known.add(key);
        messages.push({ raw, keywords: meta.keywords, receivedAt: meta.receivedAt });
      }
      if (messages.length > 0) imported += await sink.add(mailboxId, messages);
      start += batch.length;
      const next = { folder: folderIndex, position: info(batch.at(-1)!).position };
      if (Date.now() > deadline && (start < items.length || folderIndex + 1 < folders.length)) return { done: false, cursor: next, imported, skipped };
    }
  }
  return { done: true, cursor: { folder: folders.length, position: 0 }, imported, skipped };
}

export async function importFromBackup(host: Host, sink: MailboxSink, { importId, domain, name, cursor }: { importId: string; domain: string; name: string; cursor: ImportCursor }): Promise<ImportProgress> {
  const meta = await readMeta(host, importId, domain);
  const folders = await maildirFolders(join(meta.mail, name));
  return copyFolders<MaildirMessage & { index: number }>(
    sink, folders, cursor,
    async (folderIndex, position) => (await maildirMessages(folders[folderIndex]!.dir)).map((message, index) => ({ ...message, index: index + 1 })).slice(position),
    (message) => ({ size: message.size, receivedAt: message.mtime, keywords: message.keywords, position: message.index }),
    async (items) => new Map(await Promise.all(items.map(async (item) => [item, await readMaildirMessage(item.file)] as const))),
    Date.now() + BUDGET_MS,
  );
}

export interface ImapSource {
  host: string;
  port: number;
  user: string;
  password: string;
  verify: boolean;
}

export async function importFromImap(sink: MailboxSink, source: ImapSource, cursor: ImportCursor, connect = ImapClient.connect): Promise<ImportProgress> {
  const client = await connect({ host: source.host, port: source.port, verify: source.verify });
  try {
    await client.login(source.user, source.password);
    const folders = await client.folders();
    type Row = Awaited<ReturnType<ImapClient["list"]>>[number];
    let current = -1;
    return await copyFolders<Row>(
      sink, folders, cursor,
      async (folderIndex, position) => {
        current = folderIndex;
        return (await client.list(folders[folderIndex]!.name, position)).filter((row) => !row.deleted);
      },
      (row) => ({ size: row.size, receivedAt: row.receivedAt ?? new Date(), keywords: row.keywords, position: row.uid }),
      async (rows) => {
        if (rows.length === 0 || current === -1) return new Map();
        const bodies = await client.bodies(rows.map((row) => row.uid));
        return new Map(rows.flatMap((row) => (bodies.has(row.uid) ? [[row, new Uint8Array(bodies.get(row.uid)!)] as const] : [])));
      },
      Date.now() + BUDGET_MS,
    );
  } finally {
    await client.close();
  }
}
