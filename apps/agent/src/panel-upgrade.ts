import type { AgentOpName, AgentOpParams, AgentOpResult } from "@eaglepanel/shared";
import type { Host } from "./host";

/**
 * Panel upgrade from the panel: `eagle upgrade` runs in the transient unit `eaglepanel-upgrade`, outside the agent's
 * cgroup, because the installer restarts the agent and the API. Its output and exit code go to files in STATE_DIR,
 * which outlive the unit and the restarts.
 */
const UNIT = "eaglepanel-upgrade";
const STATE_DIR = "/var/lib/eaglepanel-upgrade";
const STATE = `${STATE_DIR}/state.json`;
const LOG = `${STATE_DIR}/output.log`;
const EXIT = `${STATE_DIR}/exit`;
const LOG_LINES = 80;

// The version is validated by the op schema; it goes as an argument of the script, never inside it.
const SCRIPT = 'umask 077; /usr/local/bin/eagle upgrade --version "$1" </dev/null >"$2/output.log" 2>&1; echo $? >"$2/exit"';

/** The installer colors its steps: the panel shows plain text. */
export function cleanLog(output: string): string[] {
  const lines = output
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => line.split("\r").at(-1)!.trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.slice(-LOG_LINES);
}

async function isRunning(host: Host): Promise<boolean> {
  if (host.sandbox) return false;
  return (await host.run("systemctl", ["is-active", "--quiet", `${UNIT}.service`])).code === 0;
}

async function start({ version }: AgentOpParams<"panel.upgrade">, host: Host): Promise<AgentOpResult<"panel.upgrade">> {
  if (await isRunning(host)) throw new Error("An upgrade is already running");
  await host.run("install", ["-d", "-o", "root", "-g", "root", "-m", "700", STATE_DIR]);
  await host.run("rm", ["-f", EXIT, LOG]);
  await host.writeFileAtomic(STATE, JSON.stringify({ version, startedAt: Date.now() }), 0o600);

  if (host.sandbox) {
    await host.writeFileAtomic(LOG, `Downloading EaglePanel ${version} (sandbox: nothing is installed)\n`, 0o600);
    await host.writeFileAtomic(EXIT, "0\n", 0o600);
    return { ok: true };
  }

  // A failed run from before keeps the name taken until it is reset.
  await host.run("systemctl", ["reset-failed", `${UNIT}.service`]);
  const { code, stderr } = await host.run("systemd-run", [
    `--unit=${UNIT}`,
    "--description=EaglePanel upgrade",
    "--collect",
    "--quiet",
    "/bin/sh", "-c", SCRIPT, "eagle-upgrade", version, STATE_DIR,
  ]);
  if (code !== 0) throw new Error(`systemd-run failed: ${stderr.trim().slice(0, 300)}`);
  return { ok: true };
}

async function status(_params: AgentOpParams<"panel.upgradeStatus">, host: Host): Promise<AgentOpResult<"panel.upgradeStatus">> {
  const running = await isRunning(host);
  let state: { version?: unknown; startedAt?: unknown } = {};
  try {
    state = JSON.parse((await host.readFile(STATE)) ?? "{}");
  } catch {
    // An unreadable state counts as no upgrade started.
  }
  const exit = (await host.readFile(EXIT))?.trim();
  const exitCode = !running && exit && /^\d+$/.test(exit) ? Number(exit) : null;
  return {
    running,
    version: typeof state.version === "string" ? state.version : null,
    startedAt: typeof state.startedAt === "number" ? state.startedAt : null,
    exitCode,
    log: cleanLog((await host.readFile(LOG)) ?? ""),
  };
}

type PanelUpgradeHandlers = {
  [N in Extract<AgentOpName, `panel.${string}`>]: (params: AgentOpParams<N>, host: Host) => Promise<AgentOpResult<N>>;
};

export const panelUpgradeHandlers: PanelUpgradeHandlers = {
  "panel.upgrade": start,
  "panel.upgradeStatus": status,
};
