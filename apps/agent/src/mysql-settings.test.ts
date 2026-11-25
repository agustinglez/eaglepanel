import { describe, expect, test } from "bun:test";
import type { CommandResult, Host, RunOptions } from "./host";
import { configuredOf, DIAGNOSTICS_CNF, mysqlSettingsHandlers, renderDiagnosticsCnf } from "./mysql-settings";

/** MySQL as the agent sees it: performance_schema follows the file on each restart, which can be made to fail. */
class FakeMysql implements Host {
  readonly sandbox = false;
  readonly files = new Map<string, string>();
  readonly commands: string[] = [];
  running = true;
  failRestart = false;

  async run(command: string, args: string[], _options: RunOptions = {}): Promise<CommandResult> {
    this.commands.push([command, ...args].join(" "));
    if (command === "systemctl" && args[0] === "restart") {
      if (this.failRestart) {
        this.failRestart = false;
        return { code: 1, stdout: "", stderr: "Job for mysql.service failed" };
      }
      this.running = configuredOf(this.files.get(DIAGNOSTICS_CNF) ?? null);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "mysql") return { code: 0, stdout: this.running ? "1\n" : "0\n", stderr: "" };
    if (command === "ps") return { code: 0, stdout: this.running ? " 534528\n" : " 307200\n", stderr: "" };
    if (command === "rm") this.files.delete(args.at(-1)!);
    return { code: 0, stdout: "", stderr: "" };
  }

  async writeFileAtomic(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
}

describe("MySQL performance_schema", () => {
  test("the file decides, and without it MySQL's default (on) applies", () => {
    expect(configuredOf(null)).toBe(true);
    expect(configuredOf(renderDiagnosticsCnf(false))).toBe(false);
    expect(configuredOf("[mysqld]\nperformance-schema=1\n")).toBe(true);
  });

  test("the installer writes the same file, off", async () => {
    const installer = await Bun.file(new URL("../../../deploy/install.sh", import.meta.url)).text();
    expect(/^MYSQL_DIAG_CNF=(.+)$/m.exec(installer)?.[1]).toBe(DIAGNOSTICS_CNF);
    const written = /mysql_diag_cnf\(\) \{\n  cat <<'EOF'\n([\s\S]*?)\nEOF/.exec(installer.replace(/\r\n/g, "\n"))?.[1];
    expect(`${written}\n`).toBe(renderDiagnosticsCnf(false));
  });

  test("reads what runs, what it starts with and how much memory MySQL uses", async () => {
    const host = new FakeMysql();
    host.files.set(DIAGNOSTICS_CNF, renderDiagnosticsCnf(false));
    host.running = false;
    expect(await mysqlSettingsHandlers["mysql.diagnostics.get"]({}, host)).toEqual({ running: false, configured: false, memoryMb: 300 });
  });

  test("turning it on writes the file and restarts MySQL", async () => {
    const host = new FakeMysql();
    host.files.set(DIAGNOSTICS_CNF, renderDiagnosticsCnf(false));
    host.running = false;
    expect(await mysqlSettingsHandlers["mysql.diagnostics.set"]({ enabled: true }, host)).toEqual({ running: true, configured: true, memoryMb: 522 });
    expect(host.files.get(DIAGNOSTICS_CNF)).toContain("performance_schema = ON");
    expect(host.commands).toContain("systemctl restart mysql");
  });

  test("if MySQL does not start with it, the previous file goes back", async () => {
    const host = new FakeMysql();
    host.files.set(DIAGNOSTICS_CNF, renderDiagnosticsCnf(false));
    host.running = false;
    host.failRestart = true;
    await expect(mysqlSettingsHandlers["mysql.diagnostics.set"]({ enabled: true }, host)).rejects.toThrow("previous one was restored");
    expect(host.files.get(DIAGNOSTICS_CNF)).toBe(renderDiagnosticsCnf(false));
    expect(host.commands.filter((line) => line === "systemctl restart mysql")).toHaveLength(2);
  });
});
