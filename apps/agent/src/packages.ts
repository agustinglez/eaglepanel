import {
  matchesPackagePattern,
  SYSTEM_COMPONENTS,
  systemComponent,
  type AgentOpName,
  type AgentOpParams,
  type AgentOpResult,
  type SystemComponentDef,
} from "@eaglepanel/shared";
import type { Host } from "./host";

const LSWS = "/usr/local/lsws";
const APT_OPTIONS = ["-o", "DPkg::Lock::Timeout=600", "-o", "Dpkg::Use-Pty=0", "-q"];

export interface InstalledPackage {
  name: string;
  version: string;
  source: string;
  sourceVersion: string;
}

/**
 * `dpkg-query -W -f='${Package}\t${Version}\t${source:Package}\t${source:Version}\t${db:Status-Abbrev}\n'`.
 * Only fully installed packages ("ii"): removed ones keep a row with their configuration ("rc").
 */
export function parseDpkgList(output: string): InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  for (const line of output.split("\n")) {
    const [name, version, source, sourceVersion, status] = line.split("\t");
    if (!name || !version || !status?.startsWith("ii")) continue;
    packages.push({ name, version, source: source || name, sourceVersion: sourceVersion || version });
  }
  return packages;
}

/** `apt-cache policy a b c`: the candidate version of each package. "(none)": apt does not know it. */
export function parseAptPolicy(output: string): Map<string, string | null> {
  const candidates = new Map<string, string | null>();
  let current: string | null = null;
  for (const line of output.split("\n")) {
    const header = line.match(/^(\S+):$/);
    if (header) {
      current = header[1]!.replace(/:[a-z0-9]+$/, "");
      continue;
    }
    const candidate = line.match(/^\s+Candidate:\s*(\S+)/);
    if (current && candidate) candidates.set(current, candidate[1] === "(none)" ? null : candidate[1]!);
  }
  return candidates;
}

/**
 * Installed packages of a component, in the order of its patterns (the first one is the main package). Without its
 * main package the component is not on the server, even if a shared library matches (MariaDB brings mysql-common).
 */
export function componentPackages(def: SystemComponentDef, installed: InstalledPackage[]): InstalledPackage[] {
  const main = def.packages[0];
  if (main === undefined || !installed.some((pkg) => matchesPackagePattern(pkg.name, main))) return [];
  const result: InstalledPackage[] = [];
  for (const pattern of def.packages) {
    for (const pkg of installed) {
      if (matchesPackagePattern(pkg.name, pattern) && !result.includes(pkg)) result.push(pkg);
    }
  }
  return result;
}

function readOs(content: string | null): { id: string; versionId: string } {
  const field = (name: string) => content?.match(new RegExp(`^${name}=(?:"([^"]*)"|(.*))$`, "m"))?.slice(1).find((v) => v !== undefined)?.trim() ?? "";
  return { id: field("ID"), versionId: field("VERSION_ID") };
}

async function installedPackages(host: Host): Promise<InstalledPackage[]> {
  const { code, stdout, stderr } = await host.run("dpkg-query", ["-W", "-f=${Package}\t${Version}\t${source:Package}\t${source:Version}\t${db:Status-Abbrev}\n"]);
  if (code !== 0) throw new Error(`dpkg-query failed: ${stderr.trim().slice(0, 200)}`);
  return parseDpkgList(stdout);
}

async function candidates(host: Host, names: string[]): Promise<Map<string, string | null>> {
  if (names.length === 0) return new Map();
  const { stdout } = await host.run("apt-cache", ["policy", ...names]);
  return parseAptPolicy(stdout);
}

async function binaryVersion(host: Host, def: SystemComponentDef): Promise<string | null> {
  if (!def.binary) return null;
  const { code, stdout } = await host.run(def.binary.path, [...def.binary.args]).catch(() => ({ code: 1, stdout: "" }));
  return code === 0 ? (stdout.trim().match(def.binary.pattern)?.[1] ?? null) : null;
}

/** Development: a server with a few pending updates, so the screen can be tried without one. */
function sandboxStatus(): AgentOpResult<"packages.status"> {
  const pkg = (name: string, version: string, candidate: string, source = name) => ({ name, version, source, sourceVersion: version, candidate });
  const demo: Record<string, ReturnType<typeof pkg>[]> = {
    openlitespeed: [pkg("openlitespeed", "1.8.3-1+noble", "1.8.4-1+noble")],
    php: [pkg("lsphp85", "8.5.0-1+noble", "8.5.1-1+noble"), pkg("lsphp85-common", "8.5.0-1+noble", "8.5.1-1+noble", "lsphp85")],
    mysql: [pkg("mysql-server", "8.0.43-0ubuntu0.24.04.1", "8.0.43-0ubuntu0.24.04.1", "mysql-8.0")],
    redis: [pkg("redis-server", "5:7.0.15-1build2", "5:7.0.15-1build2", "redis")],
    memcached: [pkg("memcached", "1.6.24-1build3", "1.6.24-1build3")],
    vsftpd: [pkg("vsftpd", "3.0.5-0ubuntu3", "3.0.5-0ubuntu3")],
    podman: [pkg("podman", "4.9.3+ds1-1ubuntu0.2", "4.9.3+ds1-1ubuntu0.2", "libpod")],
    openssl: [pkg("openssl", "3.0.13-0ubuntu3.4", "3.0.13-0ubuntu3.5")],
    curl: [pkg("curl", "8.5.0-2ubuntu10.6", "8.5.0-2ubuntu10.6")],
    git: [pkg("git", "1:2.43.0-1ubuntu7.3", "1:2.43.0-1ubuntu7.3")],
    nftables: [pkg("nftables", "1.0.9-1build1", "1.0.9-1build1")],
    ufw: [pkg("ufw", "0.36.2-6", "0.36.2-6")],
    "inotify-tools": [pkg("inotify-tools", "3.22.6.0-4", "3.22.6.0-4")],
  };
  return {
    os: { id: "ubuntu", versionId: "24.04" },
    components: SYSTEM_COMPONENTS.map((def) => ({
      id: def.id,
      packages: demo[def.id] ?? [],
      binaryVersion: def.id === "bun" ? Bun.version : def.id === "restic" ? "0.19.1" : null,
    })),
    refreshError: null,
  };
}

async function status({ refresh }: AgentOpParams<"packages.status">, host: Host): Promise<AgentOpResult<"packages.status">> {
  if (host.sandbox) return sandboxStatus();

  let refreshError: string | null = null;
  if (refresh) {
    const update = await host.run("env", ["DEBIAN_FRONTEND=noninteractive", "apt-get", ...APT_OPTIONS, "update"]);
    if (update.code !== 0) refreshError = `apt-get update failed: ${(update.stderr || update.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300)}`;
  }

  const installed = await installedPackages(host);
  const byComponent = SYSTEM_COMPONENTS.map((def) => ({ def, packages: componentPackages(def, installed) }));
  const policy = await candidates(host, byComponent.flatMap(({ packages }) => packages.map((p) => p.name)));
  const components = await Promise.all(
    byComponent.map(async ({ def, packages }) => ({
      id: def.id,
      packages: packages.map((p) => ({ ...p, candidate: policy.get(p.name) ?? null })),
      // A program pinned by the installer counts only when apt has no package for it.
      binaryVersion: packages.length === 0 ? await binaryVersion(host, def) : null,
    })),
  );
  return { os: readOs(await host.readFile("/etc/os-release")), components, refreshError };
}

/** Restarts what keeps the old version in memory and is not restarted by the package itself. */
async function restartAfter(id: string, host: Host): Promise<void> {
  if (id === "openlitespeed" || id === "php") {
    // Graceful: lsphp processes are started again with the new binary, open connections finish.
    const { code, stderr } = await host.run(`${LSWS}/bin/lswsctrl`, ["restart"]);
    if (code !== 0) throw new Error(`lswsctrl restart failed: ${stderr.trim().slice(0, 200)}`);
  } else if (id === "redis" || id === "memcached") {
    // The package restarts only its default instance: the accounts' instances are restarted if they are running.
    await host.run("systemctl", ["try-restart", `eaglepanel-${id}@*.service`]);
  }
}

async function upgrade({ id }: AgentOpParams<"packages.upgrade">, host: Host): Promise<AgentOpResult<"packages.upgrade">> {
  const def = systemComponent(id);
  if (!def || def.packages.length === 0) throw new Error(`${id} is not updated with apt`);
  if (host.sandbox) {
    await host.run("apt-get", ["install", "--only-upgrade", "-y", ...def.packages]);
    return { upgraded: [...def.packages] };
  }

  const packages = componentPackages(def, await installedPackages(host));
  if (packages.length === 0) throw new Error(`${def.name} is not installed`);
  const policy = await candidates(host, packages.map((p) => p.name));
  const pending = packages.filter((p) => {
    const candidate = policy.get(p.name);
    return candidate && candidate !== p.version;
  });
  if (pending.length === 0) return { upgraded: [] };

  const names = pending.map((p) => p.name);
  const { code, stdout, stderr } = await host.run("env", [
    "DEBIAN_FRONTEND=noninteractive",
    "apt-get",
    ...APT_OPTIONS,
    // The configuration files the panel or the installer wrote are kept.
    "-o", "Dpkg::Options::=--force-confdef",
    "-o", "Dpkg::Options::=--force-confold",
    "-y",
    "install",
    "--only-upgrade",
    ...names,
  ]);
  if (code !== 0) throw new Error(`apt-get failed: ${(stderr || stdout).trim().split("\n").slice(-4).join(" ").slice(0, 400)}`);
  await restartAfter(id, host);
  return { upgraded: names };
}

type PackageHandlers = {
  [N in Extract<AgentOpName, `packages.${string}`>]: (params: AgentOpParams<N>, host: Host) => Promise<AgentOpResult<N>>;
};

export const packageHandlers: PackageHandlers = {
  "packages.status": status,
  "packages.upgrade": upgrade,
};
