import { describe, expect, test } from "bun:test";
import type { CommandResult, Host, RunOptions } from "./host";
import { DEFAULT_DB_TUNING } from "@eaglepanel/shared";
import { configuredOf, DIAGNOSTICS_CNF, mysqlSettingsHandlers, renderDiagnosticsCnf, renderTuningCnf, TUNING_CNF, tuningOf } from "./mysql-settings";

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
    if (command === "mysql") {
      const sql = args.at(-1) ?? "";
      const tuning = tuningOf(this.files.get(TUNING_CNF) ?? null, "mysql");
      if (sql.includes("@@innodb_buffer_pool_size")) {
        const row = tuning
          ? [tuning.bufferPoolMb * 1048576, tuning.logBufferMb * 1048576, tuning.maxConnections, tuning.tableOpenCache, tuning.tableDefinitionCache]
          : [134217728, 67108864, 151, 4000, 2000];
        return { code: 0, stdout: `${row.join("\t")}\n`, stderr: "" };
      }
      if (sql.includes("PLUGINS")) return { code: 0, stdout: tuning?.xProtocol === false ? "DISABLED\n" : "ACTIVE\n", stderr: "" };
      return { code: 0, stdout: this.running ? "1\n" : "0\n", stderr: "" };
    }
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
    expect(await mysqlSettingsHandlers["mysql.diagnostics.get"]({}, host)).toMatchObject({ engine: "mysql", running: false, configured: false, memoryMb: 300, tuning: null });
  });

  test("turning it on writes the file and restarts MySQL", async () => {
    const host = new FakeMysql();
    host.files.set(DIAGNOSTICS_CNF, renderDiagnosticsCnf(false));
    host.running = false;
    expect(await mysqlSettingsHandlers["mysql.diagnostics.set"]({ enabled: true }, host)).toMatchObject({ engine: "mysql", running: true, configured: true, memoryMb: 522 });
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

describe("MySQL and MariaDB memory settings", () => {
  test("the installer writes the same file, with the same values, for each engine", async () => {
    const installer = (await Bun.file(new URL("../../../deploy/install.sh", import.meta.url)).text()).replace(/\r\n/g, "\n");
    expect(/^MYSQL_TUNING_CNF=(.+)$/m.exec(installer)?.[1]).toBe(TUNING_CNF);
    const body = /mysql_tuning_cnf\(\) \{\n  cat <<'EOF'\n([\s\S]*?)\nEOF/.exec(installer)?.[1];
    const x = /mysql_tuning_cnf\(\) \{[\s\S]*?\[ "\$DB_ENGINE" = mariadb \] \|\| echo '(.*)'/.exec(installer)?.[1];
    expect(`${body}\n`).toBe(renderTuningCnf(DEFAULT_DB_TUNING, "mariadb"));
    expect(`${body}\n${x}\n`).toBe(renderTuningCnf(DEFAULT_DB_TUNING, "mysql"));
  });

  test("what the file says is read back, and MariaDB never gets the X plugin line", () => {
    const custom = { bufferPoolMb: 256, logBufferMb: 16, maxConnections: 120, tableOpenCache: 2000, tableDefinitionCache: 1400, xProtocol: true };
    expect(tuningOf(renderTuningCnf(custom, "mysql"), "mysql")).toEqual(custom);
    expect(renderTuningCnf(custom, "mariadb")).not.toContain("mysqlx");
    expect(tuningOf(renderTuningCnf(custom, "mariadb"), "mariadb")).toEqual({ ...custom, xProtocol: false });
    const byHand = "[mysqld]\ninnodb_buffer_pool_size = 1G\ninnodb_log_buffer_size = 8388608\nmax_connections = 50\ntable_open_cache = 400\ntable_definition_cache = 400\n";
    expect(tuningOf(byHand, "mysql")).toEqual({ ...DEFAULT_DB_TUNING, bufferPoolMb: 1024, xProtocol: true });
    expect(tuningOf("[mysqld]\nmax_connections = 50\n", "mysql")).toBeNull();
    expect(tuningOf(null, "mysql")).toBeNull();
  });

  test("saving writes the file, restarts and reports what runs", async () => {
    const host = new FakeMysql();
    const result = await mysqlSettingsHandlers["mysql.tuning.set"]({ tuning: { ...DEFAULT_DB_TUNING, maxConnections: 80 } }, host);
    expect(host.files.get(TUNING_CNF)).toContain("max_connections = 80");
    expect(host.files.get(TUNING_CNF)).toContain("mysqlx = OFF");
    expect(result.tuning).toEqual({ ...DEFAULT_DB_TUNING, maxConnections: 80 });
    expect(result.tuningRunning).toEqual({ ...DEFAULT_DB_TUNING, maxConnections: 80 });
  });

  test("if the server does not start with them, the previous settings go back", async () => {
    const host = new FakeMysql();
    host.files.set(TUNING_CNF, renderTuningCnf(DEFAULT_DB_TUNING, "mysql"));
    host.failRestart = true;
    const tuning = { ...DEFAULT_DB_TUNING, bufferPoolMb: 32768 };
    await expect(mysqlSettingsHandlers["mysql.tuning.set"]({ tuning }, host)).rejects.toThrow("previous one was restored");
    expect(host.files.get(TUNING_CNF)).toBe(renderTuningCnf(DEFAULT_DB_TUNING, "mysql"));
  });
});
