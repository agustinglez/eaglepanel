import { z } from "zod";

/**
 * System components the panel tracks: versions, updates and known vulnerabilities. Closed list: the update operation
 * only accepts these ids, and each one upgrades only the installed packages that match its patterns.
 *
 * `packages`: apt package names; a trailing `*` matches a prefix. The first pattern that matches an installed package
 * gives the version shown. `binary`: a program installed outside apt (pinned by deploy/install.sh), used when no
 * package matches. `upstream`: when the main package matches one of these patterns it does not come from the
 * distribution (LiteSpeed or Oracle repositories), so its CVEs are looked up in NVD by `cpe` instead of in the
 * distribution security data.
 */
export interface SystemComponentDef {
  id: string;
  name: string;
  packages: readonly string[];
  binary?: { path: string; args: readonly string[]; pattern: RegExp };
  upstream?: readonly string[];
  cpe?: string;
}

export const SYSTEM_COMPONENTS = [
  { id: "openlitespeed", name: "OpenLiteSpeed", packages: ["openlitespeed"], upstream: ["openlitespeed"], cpe: "cpe:2.3:a:litespeedtech:openlitespeed" },
  { id: "php", name: "PHP 8.5 (lsphp85)", packages: ["lsphp85", "lsphp85-*"], upstream: ["lsphp*"], cpe: "cpe:2.3:a:php:php" },
  {
    id: "mysql",
    name: "MySQL",
    packages: ["mysql-server", "mysql-community-server", "mysql-server-*", "mysql-client*", "mysql-common", "mysql-community-*"],
    upstream: ["mysql-community-*"],
    cpe: "cpe:2.3:a:oracle:mysql",
  },
  { id: "redis", name: "Redis", packages: ["redis-server", "redis-tools", "redis"] },
  { id: "memcached", name: "Memcached", packages: ["memcached"] },
  { id: "vsftpd", name: "vsftpd", packages: ["vsftpd"] },
  { id: "podman", name: "Podman", packages: ["podman", "crun", "conmon", "catatonit", "containers-common"] },
  {
    id: "restic",
    name: "restic",
    packages: ["restic"],
    binary: { path: "/usr/local/bin/restic", args: ["version"], pattern: /restic\s+v?([\d.]+)/ },
  },
  {
    id: "bun",
    name: "Bun",
    packages: [],
    binary: { path: "/usr/local/bin/bun", args: ["--version"], pattern: /^v?([\d.]+)/ },
  },
  { id: "openssl", name: "OpenSSL", packages: ["openssl", "libssl3*"] },
  { id: "curl", name: "curl", packages: ["curl", "libcurl4*"] },
  { id: "git", name: "Git", packages: ["git", "git-man"] },
  { id: "nftables", name: "nftables", packages: ["nftables", "libnftables1"] },
  { id: "ufw", name: "ufw", packages: ["ufw"] },
  { id: "inotify-tools", name: "inotify-tools", packages: ["inotify-tools", "libinotifytools0"] },
] as const satisfies readonly SystemComponentDef[];

export type SystemComponentId = (typeof SYSTEM_COMPONENTS)[number]["id"];
export const systemComponentIdSchema = z.enum(SYSTEM_COMPONENTS.map((c) => c.id) as [SystemComponentId, ...SystemComponentId[]]);

export function systemComponent(id: string): SystemComponentDef | undefined {
  return (SYSTEM_COMPONENTS as readonly SystemComponentDef[]).find((c) => c.id === id);
}

/** Debian version order (`dpkg --compare-versions`): epoch, then upstream and revision, where `~` sorts before anything. */
export function compareDebianVersions(a: string, b: string): number {
  const split = (v: string) => {
    const epoch = v.match(/^(\d+):/);
    const rest = epoch ? v.slice(epoch[0].length) : v;
    const dash = rest.lastIndexOf("-");
    return { epoch: epoch ? Number(epoch[1]) : 0, upstream: dash >= 0 ? rest.slice(0, dash) : rest, revision: dash >= 0 ? rest.slice(dash + 1) : "" };
  };
  const order = (c: string) => (c === "~" ? -1 : /[a-zA-Z]/.test(c) ? c.charCodeAt(0) : c ? c.charCodeAt(0) + 256 : 0);
  const part = (x: string, y: string): number => {
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      // Non-digit run: character by character.
      while ((i < x.length && !/\d/.test(x[i]!)) || (j < y.length && !/\d/.test(y[j]!))) {
        const cx = i < x.length && !/\d/.test(x[i]!) ? x[i]! : "";
        const cy = j < y.length && !/\d/.test(y[j]!) ? y[j]! : "";
        const diff = order(cx) - order(cy);
        if (diff !== 0) return diff;
        if (cx) i++;
        if (cy) j++;
      }
      // Digit run: as numbers.
      let nx = "";
      let ny = "";
      while (i < x.length && /\d/.test(x[i]!)) nx += x[i++];
      while (j < y.length && /\d/.test(y[j]!)) ny += y[j++];
      const diff = Number(nx || 0) - Number(ny || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };
  const va = split(a);
  const vb = split(b);
  return va.epoch - vb.epoch || part(va.upstream, vb.upstream) || part(va.revision, vb.revision);
}

/** `lsphp85-*` matches `lsphp85-redis`; a pattern without `*` matches only that exact name. */
export function matchesPackagePattern(name: string, pattern: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

const installedPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  /** Source package and its version: what the distribution security data is indexed by. */
  source: z.string(),
  sourceVersion: z.string(),
  /** Version apt would install. Null if apt does not know the package (installed by hand). */
  candidate: z.string().nullable(),
});

/** A release as `eagle upgrade --version` takes it: SemVer without build metadata ("0.2.0", "1.0.0-rc.1"). */
export const releaseVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "Invalid version");

const panelUpgradeStatusSchema = z.object({
  /** The upgrade unit is running. */
  running: z.boolean(),
  /** Of the last upgrade started from the panel; null if none was. */
  version: z.string().nullable(),
  startedAt: z.number().nullable(),
  /** Exit code of `eagle upgrade`. Null while it runs, or if it stopped without one (the server restarted). */
  exitCode: z.number().nullable(),
  /** Last lines of its output. */
  log: z.array(z.string()),
});

export const packageOps = {
  "packages.status": {
    /** `refresh` runs `apt-get update` first, to see what the repositories published since the last time. */
    params: z.object({ refresh: z.boolean() }).strict(),
    result: z.object({
      /** From /etc/os-release: "ubuntu" / "24.04", "debian" / "12". */
      os: z.object({ id: z.string(), versionId: z.string() }),
      components: z.array(
        z.object({
          id: z.string(),
          packages: z.array(installedPackageSchema),
          /** Version of the program installed outside apt (`binary`), if any. */
          binaryVersion: z.string().nullable(),
        }),
      ),
      /** `apt-get update` failed: the versions are those of the last successful update. */
      refreshError: z.string().nullable(),
    }),
  },
  "packages.upgrade": {
    params: z.object({ id: systemComponentIdSchema }).strict(),
    result: z.object({ upgraded: z.array(z.string()) }),
  },
  /**
   * Starts `eagle upgrade --version V` in its own systemd unit: the installer restarts the agent and the API, and the
   * upgrade must outlive them. It returns as soon as the unit starts; `panel.upgradeStatus` follows it.
   */
  "panel.upgrade": {
    params: z.object({ version: releaseVersionSchema }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "panel.upgradeStatus": {
    params: z.object({}).strict(),
    result: panelUpgradeStatusSchema,
  },
} as const;

export type PanelUpgradeStatusDto = z.infer<typeof panelUpgradeStatusSchema>;

export type VulnerabilitySeverity = "critical" | "high" | "medium" | "low" | "negligible" | "unknown";

export interface VulnerabilityDto {
  /** CVE when there is one; otherwise the id of the source (UBUNTU-..., DEBIAN-...). */
  id: string;
  summary: string | null;
  severity: VulnerabilitySeverity;
  /** Version that fixes it, when the source says so. Null: no fix published yet (or unknown). */
  fixedIn: string | null;
  /**
   * Whether this server's apt sources already offer the fix (installed or as an update). False: published by the
   * distribution, but the provider's mirror (DigitalOcean, Hetzner, AWS...) does not have it yet. Null: no fix known.
   */
  fixReachable: boolean | null;
  url: string;
}

export interface SystemPackageDto {
  id: SystemComponentId;
  name: string;
  /** Installed version (main package or binary). Null: not installed on this server. */
  version: string | null;
  /** Version apt would install when it is newer than the installed one. */
  available: string | null;
  /** Packages of this component with an update, as "name installed → candidate". */
  pending: { name: string; installed: string; candidate: string }[];
  /** "apt": updated from the panel. "installer": pinned by deploy/install.sh, updated with `eagle upgrade`. */
  managedBy: "apt" | "installer" | null;
  vulnerabilities: VulnerabilityDto[];
  /** Where its CVEs come from: the distribution security data (OSV) or NVD for packages outside the distribution. */
  cveSource: "osv" | "nvd" | null;
}

export interface PackagesStatusDto {
  packages: SystemPackageDto[];
  /** Last time the versions were read from the server. */
  checkedAt: number | null;
  /** Last time the vulnerability sources answered. */
  cveCheckedAt: number | null;
  checking: boolean;
  /** Failed reading the server, or `apt-get update` failed (the versions may be old). */
  error: string | null;
  /** Some vulnerability source failed: its results are those of the last successful check. */
  cveError: string | null;
}
