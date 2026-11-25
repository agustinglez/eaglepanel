import type { AgentOpParams, AgentOpResult } from "@eaglepanel/shared";
import type { Host } from "./host";

/**
 * performance_schema has a file of its own, apart from the installer's eaglepanel.cnf: the installer writes it only
 * when it is missing (off), and from then on it is what the panel set. Read after eaglepanel.cnf (alphabetical order).
 */
export const DIAGNOSTICS_CNF = "/etc/mysql/conf.d/eaglepanel-diagnostics.cnf";

export const renderDiagnosticsCnf = (enabled: boolean) => `# Managed by EaglePanel (Settings › MySQL). Do not edit by hand.
[mysqld]
performance_schema = ${enabled ? "ON" : "OFF"}
`;

/** What the file says. Without the file MySQL uses its default, which is on. */
export function configuredOf(content: string | null): boolean {
  const value = /^\s*performance[_-]schema\s*=\s*(\S+)/im.exec(content ?? "")?.[1]?.toLowerCase();
  return value === undefined ? true : ["on", "1", "true"].includes(value);
}

async function state(host: Host): Promise<AgentOpResult<"mysql.diagnostics.get">> {
  const configured = configuredOf(await host.readFile(DIAGNOSTICS_CNF));
  const query = await host.run("mysql", ["--protocol=socket", "-uroot", "-N", "-B", "-e", "SELECT @@performance_schema"]);
  const running = query.code === 0 ? query.stdout.trim() === "1" : null;
  const ps = await host.run("ps", ["-C", "mysqld", "-o", "rss="]);
  const kb = ps.stdout.split("\n").map((line) => Number(line.trim())).filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  return { running, configured, memoryMb: kb > 0 ? Math.round(kb / 1024) : null };
}

export const mysqlSettingsHandlers = {
  "mysql.diagnostics.get": async (_params: AgentOpParams<"mysql.diagnostics.get">, host: Host) => {
    if (host.sandbox) return { running: false, configured: false, memoryMb: 300 };
    return state(host);
  },

  "mysql.diagnostics.set": async ({ enabled }: AgentOpParams<"mysql.diagnostics.set">, host: Host) => {
    if (host.sandbox) return { running: enabled, configured: enabled, memoryMb: enabled ? 520 : 300 };
    const previous = await host.readFile(DIAGNOSTICS_CNF);
    await host.writeFileAtomic(DIAGNOSTICS_CNF, renderDiagnosticsCnf(enabled), 0o644);
    const restart = await host.run("systemctl", ["restart", "mysql"]);
    if (restart.code !== 0) {
      // It did not come back with the new file: the previous one goes back, so the sites keep their databases.
      if (previous === null) await host.run("rm", ["-f", DIAGNOSTICS_CNF]);
      else await host.writeFileAtomic(DIAGNOSTICS_CNF, previous, 0o644);
      await host.run("systemctl", ["restart", "mysql"]);
      throw new Error(`MySQL did not start with that setting and the previous one was restored: ${restart.stderr.trim().slice(0, 200)}`);
    }
    const result = await state(host);
    if (result.running !== enabled) throw new Error(`MySQL restarted but performance_schema is ${result.running ? "on" : "off"}: another configuration file sets it`);
    return result;
  },
};
