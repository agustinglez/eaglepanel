import { MAX_EDIT_BYTES, fileRequestSchema, filePathSchema, type FileRequest } from "@eaglepanel/shared";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDownload, runFileRequest, saveUpload } from "./files";
import { workerCommand } from "./files-runner";
import { SandboxHost } from "./host";
import { handle } from "./server";

const roots: string[] = [];
let home: string;
let outside: string;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "eaglepanel-files-"));
  roots.push(root);
  home = join(root, "home", "acme");
  outside = join(root, "otra");
  mkdirSync(join(home, "public_html"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(home, "public_html", "index.php"), "<?php echo 1;\n");
  writeFileSync(join(outside, "secreto.txt"), "from another account");
});

const run = <R extends FileRequest>(request: R) => runFileRequest(home, request);
const symlinks = (() => {
  try {
    const probe = mkdtempSync(join(tmpdir(), "eaglepanel-link-"));
    roots.push(probe);
    symlinkSync(probe, join(probe, "l"), "dir");
    return true;
  } catch {
    return false;
  }
})();

describe("path format", () => {
  test("only paths relative to the home directory, without . or ..", () => {
    for (const ok of ["", "public_html", "public_html/index.php", "a b/ñandú.txt", ".htaccess"]) expect(filePathSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["/etc/passwd", "../otra", "public_html/../..", "a//b", "a/", ".", "a/./b", "a\0b"]) expect(filePathSchema.safeParse(bad).success).toBe(false);
  });

  test("three-digit permissions, without special bits", () => {
    expect(fileRequestSchema.safeParse({ op: "chmod", paths: ["a"], mode: "644" }).success).toBe(true);
    expect(fileRequestSchema.safeParse({ op: "chmod", paths: ["a"], mode: "4755" }).success).toBe(false);
    expect(fileRequestSchema.safeParse({ op: "delete", paths: [""] }).success).toBe(false);
  });
});

describe("operaciones", () => {
  test("lists directories first, with their details", async () => {
    await run({ op: "mkdir", path: "public_html/wp-content" });
    const { entries, truncated } = await run({ op: "list", path: "public_html" });
    expect(truncated).toBe(false);
    expect(entries.map(({ name, type }) => [name, type])).toEqual([["wp-content", "dir"], ["index.php", "file"]]);
    expect(entries[1]).toMatchObject({ size: 14 });
  });

  test("reads and saves text without overwriting changes made by others", async () => {
    const opened = await run({ op: "read", path: "public_html/index.php" });
    expect(opened.content).toBe("<?php echo 1;\n");
    const saved = await run({ op: "write", path: "public_html/index.php", content: "<?php echo 2;\n", mtimeMs: opened.mtimeMs });
    expect(readFileSync(join(home, "public_html", "index.php"), "utf8")).toBe("<?php echo 2;\n");

    // Someone else (FTP, WordPress itself) changed it after it was opened in the panel.
    utimesSync(join(home, "public_html", "index.php"), new Date(), new Date(Date.now() + 5000));
    await expect(run({ op: "write", path: "public_html/index.php", content: "x", mtimeMs: saved.mtimeMs })).rejects.toThrow("changed since you opened it");
    expect(readFileSync(join(home, "public_html", "index.php"), "utf8")).toBe("<?php echo 2;\n");
    // No leftover temporary files.
    expect(readdirSync(join(home, "public_html"))).toEqual(["index.php"]);
  });

  test("creating a file does not overwrite an existing one", async () => {
    await run({ op: "write", path: "public_html/nuevo.txt", content: "hola", mtimeMs: null });
    await expect(run({ op: "write", path: "public_html/nuevo.txt", content: "otra", mtimeMs: null })).rejects.toThrow("Already exists");
    expect(readFileSync(join(home, "public_html", "nuevo.txt"), "utf8")).toBe("hola");
  });

  test("does not open binary or very large files in the editor", async () => {
    writeFileSync(join(home, "logo.png"), new Uint8Array([0x89, 0x50, 0, 1]));
    await expect(run({ op: "read", path: "logo.png" })).rejects.toThrow("binary");
    writeFileSync(join(home, "grande.sql"), "a".repeat(MAX_EDIT_BYTES + 1));
    await expect(run({ op: "read", path: "grande.sql" })).rejects.toThrow("download it");
  });

  test("renames, copies and moves without overwriting anything", async () => {
    await run({ op: "mkdir", path: "backup" });
    await run({ op: "copy", paths: ["public_html/index.php"], to: "backup" });
    expect(readFileSync(join(home, "backup", "index.php"), "utf8")).toBe("<?php echo 1;\n");
    await expect(run({ op: "copy", paths: ["public_html/index.php"], to: "backup" })).rejects.toThrow("Already exists: backup/index.php");
    await run({ op: "rename", from: "backup/index.php", to: "backup/viejo.php" });
    await expect(run({ op: "rename", from: "backup/viejo.php", to: "public_html/index.php" })).rejects.toThrow("Already exists");
    await run({ op: "move", paths: ["backup/viejo.php"], to: "" });
    expect(existsSync(join(home, "viejo.php"))).toBe(true);
    await expect(run({ op: "move", paths: ["public_html"], to: "public_html/wp" })).rejects.toThrow();
    await run({ op: "mkdir", path: "public_html/wp" });
    await expect(run({ op: "move", paths: ["public_html"], to: "public_html/wp" })).rejects.toThrow("inside itself");
  });

  test("deletes whole directories and changes permissions", async () => {
    await run({ op: "mkdir", path: "tmp2" });
    writeFileSync(join(home, "tmp2", "a"), "a");
    await run({ op: "delete", paths: ["tmp2"] });
    expect(existsSync(join(home, "tmp2"))).toBe(false);
    await expect(run({ op: "delete", paths: ["tmp2"] })).rejects.toThrow("Not found: tmp2");
    if (process.platform !== "win32") {
      await run({ op: "chmod", paths: ["public_html/index.php"], mode: "600" });
      expect(statSync(join(home, "public_html", "index.php")).mode & 0o777).toBe(0o600);
    }
  });
});

describe("does not leave the home directory", () => {
  test.skipIf(!symlinks)("does not list, read or write through a link to another account", async () => {
    symlinkSync(outside, join(home, "atajo"), "dir");
    symlinkSync(join(outside, "secreto.txt"), join(home, "public_html", "secreto.txt"), "file");
    await expect(run({ op: "list", path: "atajo" })).rejects.toThrow();
    await expect(run({ op: "read", path: "atajo/secreto.txt" })).rejects.toThrow();
    await expect(run({ op: "read", path: "public_html/secreto.txt" })).rejects.toThrow();
    await expect(run({ op: "write", path: "atajo/nuevo.txt", content: "x", mtimeMs: null })).rejects.toThrow("outside the account");
    await expect(openDownload(home, "public_html/secreto.txt")).rejects.toThrow();
    await expect(saveUpload(home, "atajo/subido.txt", false, (async function* () { yield new Uint8Array([1]); })())).rejects.toThrow("outside the account");
    await expect(run({ op: "chmod", paths: ["public_html/secreto.txt"], mode: "777" })).rejects.toThrow("symbolic link");

    // Deleting the link does not touch its target; copying it copies the link.
    await run({ op: "copy", paths: ["atajo"], to: "public_html" });
    await run({ op: "delete", paths: ["atajo", "public_html/atajo"] });
    expect(readFileSync(join(outside, "secreto.txt"), "utf8")).toBe("from another account");
    expect(existsSync(join(home, "atajo"))).toBe(false);
  });
});

describe("upload and download", () => {
  const chunks = (...parts: string[]) => (async function* () {
    for (const part of parts) yield new TextEncoder().encode(part);
  })();

  test("stores the upload and downloads it unchanged", async () => {
    expect(await saveUpload(home, "public_html/datos.csv", false, chunks("a,b\n", "1,2\n"))).toEqual({ size: 8 });
    const { name, size, stream } = await openDownload(home, "public_html/datos.csv");
    expect([name, size]).toEqual(["datos.csv", 8]);
    expect(await new Response(stream).text()).toBe("a,b\n1,2\n");
  });

  test("does not overwrite without permission, and an interrupted upload leaves the previous file intact", async () => {
    await expect(saveUpload(home, "public_html/index.php", false, chunks("x"))).rejects.toThrow("Already exists");
    const broken = (async function* () {
      yield new TextEncoder().encode("a medias");
      throw new Error("connection lost");
    })();
    await expect(saveUpload(home, "public_html/index.php", true, broken)).rejects.toThrow("connection lost");
    expect(readFileSync(join(home, "public_html", "index.php"), "utf8")).toBe("<?php echo 1;\n");
    expect(readdirSync(join(home, "public_html"))).toEqual(["index.php"]);
    await saveUpload(home, "public_html/index.php", true, chunks("nuevo"));
    expect(readFileSync(join(home, "public_html", "index.php"), "utf8")).toBe("nuevo");
  });
});

describe("compress and extract", () => {
  const tools = Boolean(Bun.which("zip") && Bun.which("unzip") && process.platform !== "win32");

  test.skipIf(!tools)("zip and tar.gz round trip, without overwriting what exists", async () => {
    await run({ op: "compress", paths: ["public_html/index.php"], name: "sitio", format: "zip" });
    await run({ op: "compress", paths: ["public_html/index.php"], name: "sitio", format: "tar.gz" });
    await expect(run({ op: "compress", paths: ["public_html/index.php"], name: "sitio.zip", format: "zip" })).rejects.toThrow("Already exists");
    await run({ op: "mkdir", path: "a" });
    await run({ op: "mkdir", path: "b" });
    await run({ op: "extract", path: "public_html/sitio.zip", to: "a" });
    await run({ op: "extract", path: "public_html/sitio.tar.gz", to: "b" });
    expect(readFileSync(join(home, "a", "index.php"), "utf8")).toBe("<?php echo 1;\n");
    expect(readFileSync(join(home, "b", "index.php"), "utf8")).toBe("<?php echo 1;\n");
    writeFileSync(join(home, "a", "index.php"), "cambiado");
    await run({ op: "extract", path: "public_html/sitio.zip", to: "a" });
    expect(readFileSync(join(home, "a", "index.php"), "utf8")).toBe("cambiado");
  });

  test("compressing requires everything to be in the same directory", async () => {
    await expect(run({ op: "compress", paths: ["public_html/index.php", "otra.txt"], name: "x", format: "zip" })).rejects.toThrow("same directory");
  });
});

describe("on the server", () => {
  test("the process runs as the account user, without privileges and with a minimal environment", () => {
    const { cmd, env, cwd } = workerCommand("acme", ["download", "public_html/index.php"]);
    expect(cmd.slice(0, 6)).toEqual(["setpriv", "--reuid=acme", "--regid=acme", "--clear-groups", "--no-new-privs", "--"]);
    expect(cmd.at(-3)).toEndWith("files-worker.ts");
    expect(cmd.slice(-2)).toEqual(["download", "public_html/index.php"]);
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/acme", LC_ALL: "C.UTF-8", TMPDIR: "/home/acme/tmp", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });
    expect(cwd).toBe("/home/acme");
  });

  test("the agent uploads and downloads over HTTP, and validates the parameters", async () => {
    const root = mkdtempSync(join(tmpdir(), "eaglepanel-files-http-"));
    roots.push(root);
    const host = new SandboxHost(root);
    const upload = await handle(new Request("http://agent/files/upload?username=acme&path=public_html/a.txt", { method: "POST", body: "hola" }), host);
    expect(await upload.json()).toEqual({ size: 4 });
    const download = await handle(new Request("http://agent/files/download?username=acme&path=public_html/a.txt", { method: "POST" }), host);
    expect(download.headers.get("content-length")).toBe("4");
    expect(await download.text()).toBe("hola");
    const escape = await handle(new Request("http://agent/files/download?username=acme&path=../etc/passwd", { method: "POST" }), host);
    expect(escape.status).toBe(400);
    const noLength = await handle(new Request("http://agent/op", { method: "POST", body: new Blob(["{}"]).stream(), duplex: "half" } as RequestInit), host);
    expect(noLength.status).toBe(411);
  });
});
