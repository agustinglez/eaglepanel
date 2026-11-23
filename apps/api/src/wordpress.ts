import type {
  VulnerabilityDto,
  VulnerabilitySeverity,
  WordPressInstallDto,
  WordPressStatusDto,
  WpCoreStatus,
  WpExtension,
  WpExtensionDto,
  WpInstall,
} from "@eaglepanel/shared";
import { eq } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import type { AgentClient } from "./agent-client";
import type { Db } from "./db";
import { settings, vhosts } from "./db/schema";

/** Every hour, and two minutes after start (the server may still be bringing up its network). */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;
/**
 * The Wordfence feed is the whole database (production, measured on 2026-11-23: 44,586 records, gzip, 2.4 s). The
 * API allows one request every 30 minutes per key and answers 429 to anything more: it is downloaded once a day.
 * Matching runs on every hourly check. There is no conditional request: the feed comes with `Last-Modified` set to the
 * time of the request and a weak `ETag` that is the SHA-1 of an empty body, so neither says whether it changed.
 */
const FEED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * A check forced from the panel downloads the feed again only if the last copy is at least this old, and two requests
 * are never closer than this, even after a failure: Wordfence's limit (30 min) plus a margin.
 */
const FEED_FORCE_MIN_MS = 35 * 60 * 1000;
/** Versions on WordPress.org: a forced check asks again even inside this window. */
const VERSION_CACHE_MS = 50 * 60 * 1000;
const TIMEOUT_MS = 20_000;
const FEED_TIMEOUT_MS = 10 * 60 * 1000;
const PARALLEL_LOOKUPS = 4;
const USER_AGENT = "EaglePanel WordPress check";
/**
 * Scanner feed: affected and patched versions, title and link, without CVE number or CVSS (every entry shows as
 * unrated). The production feed (`.../vulnerabilities/production`) adds them but holds only fully analyzed records.
 * Both have the same format: switching is changing this URL.
 */
const FEED_URL = "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/scanner";
export const WORDFENCE_KEY_SETTING = "wordfence_api_key";

// ---------------------------------------------------------------------------------------------------------------
// Versions

/**
 * PHP `version_compare`, which is how WordPress compares plugin versions: "1.0" < "1.0.1", "1.0-beta" < "1.0",
 * "1.0RC1" < "1.0". Parts are split at dots, dashes and changes between digits and letters.
 */
export function compareWpVersions(a: string, b: string): number {
  const special: Record<string, number> = { dev: 0, alpha: 1, a: 1, beta: 2, b: 2, rc: 3, "#": 4, pl: 5, p: 5 };
  const parts = (v: string) =>
    v
      .trim()
      .replace(/[-_+]/g, ".")
      .replace(/(\d)([^\d.])/g, "$1.$2")
      .replace(/([^\d.])(\d)/g, "$1.$2")
      .split(".")
      .filter(Boolean);
  const rank = (p: string) => (/^\d+$/.test(p) ? special["#"]! : (special[p.toLowerCase()] ?? -1));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    // A missing part counts as a 0: "1.0" equals "1.0.0" and comes after "1.0.beta".
    const px = x[i] ?? "0";
    const py = y[i] ?? "0";
    if (/^\d+$/.test(px) && /^\d+$/.test(py)) {
      const diff = Number(px) - Number(py);
      if (diff !== 0) return Math.sign(diff);
    } else {
      const diff = rank(px) - rank(py);
      if (diff !== 0) return Math.sign(diff);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Wordfence Intelligence

interface WfRange {
  from_version: string;
  from_inclusive: boolean;
  to_version: string;
  to_inclusive: boolean;
}

interface WfRecord {
  id: string;
  title?: string;
  informational?: boolean;
  software?: { type: string; slug: string; affected_versions?: Record<string, WfRange>; patched_versions?: string[] }[];
  references?: string[];
  cvss?: { score?: number; rating?: string } | null;
  cve?: string | null;
  published?: string | null;
}

/** What is kept of each record: enough to match a version and show a line. */
export interface WfEntry {
  id: string;
  title: string;
  cve: string | null;
  severity: VulnerabilitySeverity;
  url: string;
  /** [from, fromInclusive, to, toInclusive]; "*" is unbounded. */
  ranges: [string, boolean, string, boolean][];
  patched: string[];
}

export interface WfIndex {
  /** `plugin:<slug>`, `theme:<slug>`, `core:wordpress`. */
  bySoftware: Record<string, WfEntry[]>;
  /** When this copy of the feed was downloaded. */
  updatedAt: number;
  records: number;
}

function wfSeverity(rating: string | undefined): VulnerabilitySeverity {
  switch (rating?.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    case "none":
      return "negligible";
    default:
      return "unknown";
  }
}

/** Adds one feed record to the index. Informational records (no real-world impact) and unpublished ones are left out. */
export function indexRecord(index: WfIndex, record: WfRecord): void {
  if (!record?.id || record.informational || !record.published || !record.software?.length) return;
  index.records++;
  const url = record.references?.find((r) => r.includes("wordfence.com")) ?? `https://www.wordfence.com/threat-intel/vulnerabilities/id/${record.id}`;
  for (const software of record.software) {
    const type = software.type === "core" ? "core" : software.type;
    const key = `${type}:${type === "core" ? "wordpress" : software.slug}`;
    const entry: WfEntry = {
      id: record.id,
      title: (record.title ?? "").slice(0, 300),
      cve: record.cve ?? null,
      severity: wfSeverity(record.cvss?.rating),
      url,
      ranges: Object.values(software.affected_versions ?? {}).map((r) => [r.from_version, r.from_inclusive, r.to_version, r.to_inclusive]),
      patched: software.patched_versions ?? [],
    };
    (index.bySoftware[key] ??= []).push(entry);
  }
}

/**
 * Records of the feed one by one, without holding the whole document: its root is an object of records keyed by
 * UUID, so each value at depth 2 is cut out and parsed on its own. Memory stays at the size of one record.
 */
export async function* streamRecords(chunks: AsyncIterable<string>): AsyncGenerator<unknown> {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let buffer = "";
  let start = -1;
  for await (const chunk of chunks) {
    const offset = buffer.length;
    buffer += chunk;
    for (let i = offset; i < buffer.length; i++) {
      const c = buffer.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 92) escaped = true;
        else if (c === 34) inString = false;
        continue;
      }
      if (c === 34) inString = true;
      else if (c === 123 || c === 91) {
        depth++;
        if (depth === 2 && c === 123) start = i;
      } else if (c === 125 || c === 93) {
        depth--;
        if (depth === 1 && start >= 0) {
          yield JSON.parse(buffer.slice(start, i + 1));
          start = -1;
        }
      }
    }
    if (start >= 0) {
      buffer = buffer.slice(start);
      start = 0;
    } else {
      buffer = "";
    }
  }
}

/** Downloads the whole feed and indexes it record by record. */
export async function fetchFeed(key: string, fetcher: typeof fetch = fetch): Promise<WfIndex> {
  const response = await fetcher(FEED_URL, {
    headers: { authorization: `Bearer ${key}`, "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) throw new Error("Wordfence rejected the API key");
  if (response.status === 429) throw new Error("Wordfence is limiting requests (429): the feed is downloaded again later");
  if (!response.ok || !response.body) throw new Error(`Wordfence answered ${response.status}`);
  const index: WfIndex = { bySoftware: {}, updatedAt: Date.now(), records: 0 };
  for await (const record of streamRecords(response.body.pipeThrough(new TextDecoderStream()))) indexRecord(index, record as WfRecord);
  if (index.records === 0) throw new Error("The Wordfence feed came empty");
  return index;
}

function inRange(version: string, [from, fromInc, to, toInc]: WfEntry["ranges"][number]): boolean {
  if (from !== "*") {
    const c = compareWpVersions(version, from);
    if (c < 0 || (c === 0 && !fromInc)) return false;
  }
  if (to !== "*") {
    const c = compareWpVersions(version, to);
    if (c > 0 || (c === 0 && !toInc)) return false;
  }
  return true;
}

const SEVERITY_ORDER: VulnerabilitySeverity[] = ["critical", "high", "medium", "low", "negligible", "unknown"];

/** Known vulnerabilities of a version, worst first. The fix shown is the first patched version after the installed one. */
export function matchVulnerabilities(index: WfIndex | null, key: string, version: string): VulnerabilityDto[] {
  if (!index || !version) return [];
  const result = new Map<string, VulnerabilityDto>();
  for (const entry of index.bySoftware[key] ?? []) {
    if (!entry.ranges.some((range) => inRange(version, range))) continue;
    const id = entry.cve ?? `WF-${entry.id.slice(0, 8)}`;
    if (result.has(id)) continue;
    const fixedIn = entry.patched.filter((p) => compareWpVersions(p, version) > 0).sort(compareWpVersions)[0] ?? null;
    result.set(id, { id, summary: entry.title || null, severity: entry.severity, fixedIn, fixReachable: null, url: entry.url });
  }
  return [...result.values()].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.id.localeCompare(a.id));
}

// ---------------------------------------------------------------------------------------------------------------
// WordPress.org

type ExtensionInfo = { found: true; latest: string } | { found: false; closed: boolean; reason: string | null };

const INFO_FIELDS = ["sections", "description", "versions", "reviews", "banners", "icons", "screenshots", "contributors", "ratings", "compatibility", "tags"]
  .map((f) => `request[fields][${f}]=0`)
  .join("&");

async function getJson(url: string): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  // 404 is an answer ("not found", "closed"); anything else that is not OK is a failure.
  if (!response.ok && response.status !== 404) throw new Error(`WordPress.org answered ${response.status}`);
  return { status: response.status, data };
}

async function extensionInfo(type: "plugin" | "theme", slug: string): Promise<ExtensionInfo> {
  const action = type === "plugin" ? "plugin_information" : "theme_information";
  const { data } = await getJson(`https://api.wordpress.org/${type}s/info/1.2/?action=${action}&request[slug]=${encodeURIComponent(slug)}&${INFO_FIELDS}`);
  if (data && typeof data.version === "string" && !data.error) return { found: true, latest: data.version };
  const closed = data?.closed === true || data?.error === "closed";
  return { found: false, closed, reason: closed && typeof data?.reason_text === "string" ? data.reason_text : null };
}

interface CoreInfo {
  latest: string | null;
  /** Release → "latest" | "outdated" | "insecure", from WordPress.org. */
  releases: Record<string, string>;
}

async function coreInfo(): Promise<CoreInfo> {
  const [check, stable] = await Promise.all([
    getJson("https://api.wordpress.org/core/version-check/1.7/"),
    getJson("https://api.wordpress.org/core/stable-check/1.0/"),
  ]);
  const offers = (check.data?.offers ?? []) as { current?: string }[];
  return { latest: offers[0]?.current ?? null, releases: (stable.data ?? {}) as Record<string, string> };
}

export function coreStatus(version: string, core: CoreInfo | null): WpCoreStatus {
  if (!core) return "unknown";
  const known = core.releases[version];
  if (known === "latest" || known === "outdated" || known === "insecure") return known;
  if (!core.latest) return "unknown";
  return compareWpVersions(version, core.latest) >= 0 ? "latest" : "outdated";
}

export function extensionDto(type: "plugin" | "theme", ext: WpExtension, info: ExtensionInfo | undefined, index: WfIndex | null): WpExtensionDto {
  const vulnerabilities = matchVulnerabilities(index, `${type}:${ext.slug}`, ext.version);
  if (!info) return { ...ext, latest: null, status: "unknown", closedReason: null, vulnerabilities };
  if (!info.found) return { ...ext, latest: null, status: info.closed ? "closed" : "unknown", closedReason: info.reason, vulnerabilities };
  const outdated = ext.version !== "" && compareWpVersions(ext.version, info.latest) < 0;
  return { ...ext, latest: info.latest, status: outdated ? "outdated" : "up-to-date", closedReason: null, vulnerabilities };
}

// ---------------------------------------------------------------------------------------------------------------
// Monitor

interface VhostRow {
  id: number;
  username: string;
  slug: string;
  name: string;
  hostname: string;
  docRoot: string;
}

export function toInstallDto(install: WpInstall, vhost: VhostRow, core: CoreInfo | null, infos: Map<string, ExtensionInfo>, index: WfIndex | null): WordPressInstallDto {
  const below = install.path === vhost.docRoot ? "" : install.path.slice(vhost.docRoot.length);
  return {
    id: `${install.vhost}:${install.path}`,
    username: install.username,
    vhostId: vhost.id,
    vhostSlug: vhost.slug,
    vhostName: vhost.name,
    hostname: vhost.hostname,
    path: install.path,
    urlPath: below || "/",
    version: install.version,
    latest: core?.latest ?? null,
    coreStatus: coreStatus(install.version, core),
    multisite: install.multisite,
    coreVulnerabilities: matchVulnerabilities(index, "core:wordpress", install.version),
    plugins: install.plugins.map((p) => extensionDto("plugin", p, infos.get(`plugin:${p.slug}`), index)),
    themes: install.themes.map((t) => extensionDto("theme", t, infos.get(`theme:${t.slug}`), index)),
  };
}

async function inParallel<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
    }),
  );
}

export interface WordPressMonitorDeps {
  db: Db;
  agent: AgentClient;
  /** Where the feed index is kept between restarts. Without it, it lives in memory only. */
  dataDir?: string;
  /** Tests make no outside requests: versions and vulnerabilities stay unknown. */
  online?: boolean;
}

export function createWordPressMonitor({ db, agent, dataDir, online = true }: WordPressMonitorDeps) {
  const indexFile = dataDir ? `${dataDir}/wordfence-index.json` : null;
  const apiKey = () => db.select().from(settings).where(eq(settings.key, WORDFENCE_KEY_SETTING)).get()?.value ?? null;

  let index: WfIndex | null = null;
  if (indexFile && existsSync(indexFile)) {
    try {
      index = JSON.parse(readFileSync(indexFile, "utf8")) as WfIndex;
    } catch (error) {
      console.error("[api] could not read the Wordfence index:", error);
    }
  }

  let core: CoreInfo | null = null;
  let coreAt = 0;
  const infos = new Map<string, { at: number; info: ExtensionInfo }>();
  let feedError: string | null = null;
  let lastFeedAttempt = 0;
  let status: WordPressStatusDto = {
    installs: [],
    latestCore: null,
    checkedAt: null,
    checking: false,
    error: null,
    versionsError: null,
    vulnerabilities: { configured: false, updatedAt: index?.updatedAt ?? null, records: index?.records ?? 0, error: null },
  };
  let running: Promise<WordPressStatusDto> | null = null;

  async function refreshFeed(force: boolean): Promise<void> {
    const key = apiKey();
    if (!key || !online) return;
    const age = index ? Date.now() - index.updatedAt : Infinity;
    if (age < (force ? FEED_FORCE_MIN_MS : FEED_MAX_AGE_MS)) return;
    // After a failed request (a 429, usually) the next one waits at least this long, even if forced.
    if (Date.now() - lastFeedAttempt < FEED_FORCE_MIN_MS) return;
    lastFeedAttempt = Date.now();
    try {
      index = await fetchFeed(key);
      feedError = null;
      if (indexFile) {
        await writeFile(`${indexFile}.tmp`, JSON.stringify(index), { mode: 0o600 });
        await rename(`${indexFile}.tmp`, indexFile);
      }
    } catch (error) {
      // The last downloaded index keeps being used.
      feedError = error instanceof Error ? error.message : String(error);
      console.error("[api] Wordfence feed failed:", feedError);
    }
  }

  async function refreshVersions(installs: WpInstall[], force: boolean): Promise<string | null> {
    if (!online) return null;
    const errors: string[] = [];
    const fresh = (at: number) => !force && Date.now() - at < VERSION_CACHE_MS;
    if (!core || !fresh(coreAt)) {
      try {
        core = await coreInfo();
        coreAt = Date.now();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const wanted = new Set<string>();
    for (const install of installs) {
      for (const p of install.plugins) wanted.add(`plugin:${p.slug}`);
      for (const t of install.themes) wanted.add(`theme:${t.slug}`);
    }
    const stale = [...wanted].filter((key) => {
      const cached = infos.get(key);
      return !cached || !fresh(cached.at);
    });
    await inParallel(stale, PARALLEL_LOOKUPS, async (key) => {
      const [type, slug] = key.split(":") as ["plugin" | "theme", string];
      try {
        infos.set(key, { at: Date.now(), info: await extensionInfo(type, slug) });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    });
    return errors.length ? [...new Set(errors)].join("; ") : null;
  }

  async function run(force: boolean): Promise<WordPressStatusDto> {
    status = { ...status, checking: true };
    try {
      // Only PHP environments: an app has no files in its document root to scan.
      const rows: VhostRow[] = db
        .select({ id: vhosts.id, username: vhosts.username, slug: vhosts.slug, name: vhosts.name, hostname: vhosts.hostname, docRoot: vhosts.docRoot })
        .from(vhosts)
        .where(eq(vhosts.type, "php"))
        .all();
      const byId = new Map(rows.map((row) => [row.id, row]));
      const [scan] = await Promise.all([
        rows.length ? agent.call("wordpress.scan", { sites: rows.map((r) => ({ username: r.username, vhost: r.id, docRoot: r.docRoot })) }) : { installs: [], errors: [] },
        refreshFeed(force),
      ]);
      const versionsError = await refreshVersions(scan.installs, force);
      const known = new Map([...infos].map(([key, value]) => [key, value.info]));
      const installs = scan.installs
        .filter((install) => byId.has(install.vhost))
        .map((install) => toInstallDto(install, byId.get(install.vhost)!, core, known, index))
        .sort((a, b) => a.username.localeCompare(b.username) || a.vhostName.localeCompare(b.vhostName) || a.path.localeCompare(b.path));
      status = {
        installs,
        latestCore: core?.latest ?? null,
        checkedAt: Date.now(),
        checking: false,
        error: scan.errors.length ? scan.errors.map((e) => `${e.username}: ${e.message}`).join("; ") : null,
        versionsError,
        vulnerabilities: {
          configured: apiKey() !== null,
          updatedAt: index?.updatedAt ?? null,
          records: index?.records ?? 0,
          error: feedError,
        },
      };
    } catch (error) {
      status = { ...status, checking: false, error: error instanceof Error ? error.message : String(error) };
      console.error("[api] WordPress check failed:", status.error);
    }
    return status;
  }

  function check(options: { force?: boolean } = {}): Promise<WordPressStatusDto> {
    running ??= run(options.force ?? false).finally(() => {
      running = null;
    });
    return running;
  }

  return {
    get: (): WordPressStatusDto => ({ ...status, vulnerabilities: { ...status.vulnerabilities, configured: apiKey() !== null } }),
    check,
    /** A new or removed key: the next check downloads the feed with it, or stops showing vulnerabilities. */
    keyChanged(saved: boolean) {
      if (!saved) {
        index = null;
        feedError = null;
        lastFeedAttempt = 0;
        if (indexFile) void rm(indexFile, { force: true }).catch(() => undefined);
      }
      // A check already running would not use the new key: the next one starts when it ends.
      void (running ?? Promise.resolve()).then(() => check({ force: saved }));
    },
    start() {
      const first = setTimeout(() => void check(), FIRST_CHECK_MS);
      const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
      return () => {
        clearTimeout(first);
        clearInterval(timer);
      };
    },
  };
}
