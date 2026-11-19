import {
  compareDebianVersions,
  matchesPackagePattern,
  SYSTEM_COMPONENTS,
  type AgentOpResult,
  type PackagesStatusDto,
  type SystemComponentDef,
  type SystemPackageDto,
  type VulnerabilityDto,
  type VulnerabilitySeverity,
} from "@eaglepanel/shared";
import type { AgentClient } from "./agent-client";

/** Every 30 min, and 90 s after start (the server may still be bringing up its network). */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const FIRST_CHECK_MS = 90 * 1000;
/** A version already looked up is asked again after this long, unless the check is forced from the panel. */
const CVE_CACHE_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 20_000;
const MAX_VULNS = 100;
const USER_AGENT = "EaglePanel package check";

type AgentStatus = AgentOpResult<"packages.status">;
type AgentComponent = AgentStatus["components"][number];
type Installed = AgentComponent["packages"][number];

/** "1:8.5.1-1+noble" → "8.5.1": the upstream version NVD knows. */
export function upstreamVersion(version: string): string {
  return version.replace(/^\d+:/, "").split(/[-+~]/)[0] ?? version;
}

/** OSV ecosystem of the distribution: "Ubuntu:24.04:LTS", "Ubuntu:25.10", "Debian:12". Null if it has none. */
export function osvEcosystem(os: AgentStatus["os"]): string | null {
  if (os.id === "ubuntu" && /^\d+\.\d+$/.test(os.versionId)) {
    const [year, month] = os.versionId.split(".").map(Number);
    return `Ubuntu:${os.versionId}${year! % 2 === 0 && month === 4 ? ":LTS" : ""}`;
  }
  if (os.id === "debian" && /^\d+$/.test(os.versionId)) return `Debian:${os.versionId}`;
  return null;
}

const SEVERITY_ORDER: VulnerabilitySeverity[] = ["critical", "high", "medium", "low", "negligible", "unknown"];

function normalizeSeverity(value: unknown): VulnerabilitySeverity {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text === "moderate") return "medium";
  // Debian security tracker urgency.
  if (text === "unimportant") return "negligible";
  return (SEVERITY_ORDER as string[]).includes(text) ? (text as VulnerabilitySeverity) : "unknown";
}

const sortVulns = (vulns: VulnerabilityDto[]) =>
  vulns.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.id.localeCompare(a.id)).slice(0, MAX_VULNS);

interface OsvVuln {
  id: string;
  withdrawn?: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  upstream?: string[];
  severity?: { type: string; score: string }[];
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events?: Record<string, string>[] }[]; ecosystem_specific?: { urgency?: string } }[];
  database_specific?: { severity?: string };
}

/**
 * An OSV record as shown in the panel. Ubuntu records carry the Ubuntu priority; Debian ones usually none. `affected`
 * lists every release of the distribution: the fixed version is taken only from this server's one.
 */
export function fromOsv(vuln: OsvVuln, source: string, ecosystem: string): VulnerabilityDto {
  const cve = [...(vuln.upstream ?? []), ...(vuln.aliases ?? [])].find((id) => id.startsWith("CVE-")) ?? vuln.id.replace(/^(UBUNTU|DEBIAN)-(?=CVE-)/, "");
  const ubuntu = vuln.severity?.find((s) => s.type === "Ubuntu")?.score;
  const affected = vuln.affected?.find((a) => a.package?.name === source && a.package.ecosystem === ecosystem);
  const fixedIn = affected?.ranges?.flatMap((r) => r.events ?? []).find((e) => e.fixed)?.fixed ?? null;
  const text = vuln.summary || vuln.details || null;
  return {
    id: cve,
    summary: text ? text.slice(0, 300) : null,
    severity: normalizeSeverity(ubuntu ?? affected?.ecosystem_specific?.urgency ?? vuln.database_specific?.severity),
    fixedIn,
    fixReachable: null,
    url: `https://osv.dev/vulnerability/${encodeURIComponent(vuln.id)}`,
  };
}

async function queryOsv(ecosystem: string, pkg: Installed): Promise<VulnerabilityDto[]> {
  const vulns = new Map<string, VulnerabilityDto>();
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const response = await fetch("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ package: { name: pkg.source, ecosystem }, version: pkg.sourceVersion, ...(pageToken ? { page_token: pageToken } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OSV answered ${response.status}`);
    const data = (await response.json()) as { vulns?: OsvVuln[]; next_page_token?: string };
    for (const vuln of data.vulns ?? []) {
      if (vuln.withdrawn) continue;
      const dto = fromOsv(vuln, pkg.source, ecosystem);
      // The same CVE can come as an UBUNTU- record and a USN: the first one is kept.
      if (!vulns.has(dto.id)) vulns.set(dto.id, dto);
    }
    pageToken = data.next_page_token;
    if (!pageToken) break;
  }
  return sortVulns([...vulns.values()]);
}

interface NvdItem {
  cve: {
    id: string;
    descriptions?: { lang: string; value: string }[];
    metrics?: Record<string, { cvssData?: { baseSeverity?: string }; baseSeverity?: string }[]>;
  };
}

export function fromNvd(item: NvdItem): VulnerabilityDto {
  const metrics = item.cve.metrics ?? {};
  const metric = ["cvssMetricV40", "cvssMetricV31", "cvssMetricV30", "cvssMetricV2"].map((key) => metrics[key]?.[0]).find(Boolean);
  const text = item.cve.descriptions?.find((d) => d.lang === "en")?.value ?? null;
  return {
    id: item.cve.id,
    summary: text ? text.slice(0, 300) : null,
    severity: normalizeSeverity(metric?.cvssData?.baseSeverity ?? metric?.baseSeverity),
    fixedIn: null,
    fixReachable: null,
    url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(item.cve.id)}`,
  };
}

/** CVEs whose vulnerable configurations include this exact version of the product. */
async function queryNvd(cpe: string, version: string): Promise<VulnerabilityDto[]> {
  const match = `${cpe}:${version}`;
  const response = await fetch(`https://services.nvd.nist.gov/rest/json/cves/2.0?noRejected&virtualMatchString=${encodeURIComponent(match)}`, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`NVD answered ${response.status}`);
  const data = (await response.json()) as { vulnerabilities?: NvdItem[] };
  return sortVulns((data.vulnerabilities ?? []).map(fromNvd));
}

type CveQuery = { kind: "osv"; ecosystem: string; pkg: Installed } | { kind: "nvd"; cpe: string; version: string };

/** Where the CVEs of a component are looked up, if anywhere. */
export function cveQueryFor(def: SystemComponentDef, component: AgentComponent, ecosystem: string | null): CveQuery | null {
  const main = component.packages[0];
  if (!main) return null;
  const upstream = def.upstream?.some((pattern) => matchesPackagePattern(main.name, pattern));
  if (upstream) return def.cpe ? { kind: "nvd", cpe: def.cpe, version: upstreamVersion(main.version) } : null;
  return ecosystem ? { kind: "osv", ecosystem, pkg: main } : null;
}

const cacheKey = (query: CveQuery) => (query.kind === "osv" ? `osv|${query.ecosystem}|${query.pkg.source}|${query.pkg.sourceVersion}` : `nvd|${query.cpe}|${query.version}`);

/** Turns what the agent read into what the panel shows. Components not installed on this server are left out. */
export function toPackageDtos(status: AgentStatus, vulnsFor: (id: string) => VulnerabilityDto[], sourceFor: (id: string) => "osv" | "nvd" | null): SystemPackageDto[] {
  const result: SystemPackageDto[] = [];
  for (const def of SYSTEM_COMPONENTS) {
    const component = status.components.find((c) => c.id === def.id);
    if (!component) continue;
    const main = component.packages[0];
    const version = main?.version ?? component.binaryVersion;
    if (!version) continue;
    const pending = component.packages
      .filter((p) => p.candidate !== null && p.candidate !== p.version)
      .map((p) => ({ name: p.name, installed: p.version, candidate: p.candidate! }));
    result.push({
      id: def.id,
      name: def.name,
      version,
      available: pending.find((p) => p.name === main?.name)?.candidate ?? pending[0]?.candidate ?? null,
      pending,
      managedBy: main ? "apt" : "installer",
      // The newest version this server's sources offer: the candidate, or the installed one when nothing is pending.
      vulnerabilities: vulnsFor(def.id).map((v) => {
        const best = main?.candidate ?? main?.sourceVersion ?? null;
        return { ...v, fixReachable: v.fixedIn && best ? compareDebianVersions(best, v.fixedIn) >= 0 : null };
      }),
      cveSource: sourceFor(def.id),
    });
  }
  return result;
}

export function createPackageMonitor({ agent }: { agent: AgentClient }) {
  let status: PackagesStatusDto = { packages: [], checkedAt: null, cveCheckedAt: null, checking: false, error: null, cveError: null };
  const cache = new Map<string, { at: number; vulns: VulnerabilityDto[] }>();
  let running: Promise<PackagesStatusDto> | null = null;

  async function lookup(query: CveQuery, force: boolean): Promise<VulnerabilityDto[]> {
    const key = cacheKey(query);
    const cached = cache.get(key);
    if (cached && !force && Date.now() - cached.at < CVE_CACHE_MS) return cached.vulns;
    const vulns = query.kind === "osv" ? await queryOsv(query.ecosystem, query.pkg) : await queryNvd(query.cpe, query.version);
    cache.set(key, { at: Date.now(), vulns });
    return vulns;
  }

  async function run({ refresh, force }: { refresh: boolean; force: boolean }): Promise<PackagesStatusDto> {
    status = { ...status, checking: true };
    try {
      const read = await agent.call("packages.status", { refresh });
      const ecosystem = osvEcosystem(read.os);
      const queries = new Map<string, CveQuery>();
      for (const def of SYSTEM_COMPONENTS) {
        const component = read.components.find((c) => c.id === def.id);
        const query = component && cveQueryFor(def, component, ecosystem);
        if (query) queries.set(def.id, query);
      }

      const vulns = new Map<string, VulnerabilityDto[]>();
      const errors: string[] = [];
      // NVD allows 5 requests per 30 s without a key: its queries go one after another; OSV ones in parallel.
      const nvd = [...queries].filter(([, q]) => q.kind === "nvd");
      const osv = [...queries].filter(([, q]) => q.kind === "osv");
      await Promise.all([
        ...osv.map(async ([id, query]) => {
          try {
            vulns.set(id, await lookup(query, force));
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }),
        (async () => {
          for (const [id, query] of nvd) {
            try {
              vulns.set(id, await lookup(query, force));
            } catch (error) {
              errors.push(error instanceof Error ? error.message : String(error));
            }
          }
        })(),
      ]);

      // A failed source keeps the last known result for that component.
      const previous = new Map(status.packages.map((p) => [p.id, p.vulnerabilities]));
      const packages = toPackageDtos(read, (id) => vulns.get(id) ?? previous.get(id as never) ?? [], (id) => queries.get(id)?.kind ?? null);
      const cveError = errors.length ? [...new Set(errors)].join("; ") : null;
      if (cveError) console.error("[api] vulnerability check failed:", cveError);
      status = {
        packages,
        checkedAt: Date.now(),
        cveCheckedAt: errors.length < queries.size ? Date.now() : status.cveCheckedAt,
        checking: false,
        error: read.refreshError,
        cveError,
      };
    } catch (error) {
      status = { ...status, checking: false, error: error instanceof Error ? error.message : String(error) };
      console.error("[api] package check failed:", status.error);
    }
    return status;
  }

  function check(options: { refresh: boolean; force?: boolean }): Promise<PackagesStatusDto> {
    running ??= run({ refresh: options.refresh, force: options.force ?? false }).finally(() => {
      running = null;
    });
    return running;
  }

  return {
    get: () => status,
    check,
    start() {
      const first = setTimeout(() => void check({ refresh: true }), FIRST_CHECK_MS);
      const timer = setInterval(() => void check({ refresh: true }), CHECK_INTERVAL_MS);
      return () => {
        clearTimeout(first);
        clearInterval(timer);
      };
    },
  };
}
