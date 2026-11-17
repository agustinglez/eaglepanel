import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Sensitive data always goes through stdin, never as an argument: it would be visible in `ps`. */
  stdin?: string;
}

/** Everything that touches the server goes through here, so it can run in sandbox mode during development. */
export interface Host {
  readonly sandbox: boolean;
  run(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
  writeFileAtomic(path: string, content: string, mode?: number): Promise<void>;
  /** Returns `null` if the file does not exist. */
  readFile(path: string): Promise<string | null>;
}

const CLEAN_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" };

/** Real host: `Bun.spawn` with an argument array and a clean environment. It never uses a shell. */
export class SystemHost implements Host {
  readonly sandbox = false;

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    const proc = Bun.spawn([command, ...args], {
      env: CLEAN_ENV,
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  async writeFileAtomic(path: string, content: string, mode = 0o644): Promise<void> {
    await atomicWrite(path, content, mode);
  }

  async readFile(path: string): Promise<string | null> {
    const file = Bun.file(path);
    return (await file.exists()) ? file.text() : null;
  }
}

/** Development host: records commands without running them and confines writes to `root`. */
export class SandboxHost implements Host {
  readonly sandbox = true;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Translates an absolute server path to its equivalent inside the sandbox. */
  resolvePath(path: string): string {
    if (!path.startsWith("/") && !isAbsolute(path)) {
      throw new Error(`Path is not absolute: ${path}`);
    }
    const target = resolve(this.root, `.${path.startsWith("/") ? path : `/${path}`}`);
    const rel = relative(this.root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path outside the sandbox: ${path}`);
    }
    return target;
  }

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    await mkdir(this.root, { recursive: true });
    // Only whether there was stdin is recorded, not its content: it may be a password.
    const entry = { at: new Date().toISOString(), command, args, stdin: options.stdin !== undefined };
    await appendFile(join(this.root, "commands.log"), `${JSON.stringify(entry)}\n`);
    return { code: 0, stdout: "", stderr: "" };
  }

  async writeFileAtomic(path: string, content: string, mode = 0o644): Promise<void> {
    await atomicWrite(this.resolvePath(path), content, mode);
  }

  async readFile(path: string): Promise<string | null> {
    const file = Bun.file(this.resolvePath(path));
    return (await file.exists()) ? file.text() : null;
  }
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, content, { mode });
  await rename(temp, path);
}
