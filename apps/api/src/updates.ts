import type { UpdateStatusDto } from "@eaglepanel/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where new versions are announced: every installation checks the GitHub Releases of this repository.
 * `EAGLEPANEL_UPDATE_REPO` or `EAGLEPANEL_UPDATE_URL` in /etc/eaglepanel/update.env override it per server.
 */
const DEFAULT_UPDATE_REPO = "agustinglez/eaglepanel";

/** Every 6 h, and 1 min after start (the server may still be bringing up its network). */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
const TIMEOUT_MS = 10_000;
const MAX_NOTES = 4000;

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** The installed version: `VERSION` at the project root, written by deploy/package.sh. Null in development. */
export function readCurrentVersion(root: string): string | null {
  const file = join(root, "VERSION");
  if (!existsSync(file)) return null;
  const version = readFileSync(file, "utf8").trim();
  return version || null;
}

/**
 * SemVer 2.0 precedence: "v1.10.0" > "1.9.3", "1.0.0" > "1.0.0-rc.1" > "1.0.0-beta.11" > "1.0.0-beta.2". Build
 * metadata does not count: "0.1.0+202611162215" (a local build) equals "0.1.0". Negative, zero or positive.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", ...pre] = v.trim().replace(/^v/i, "").split("+")[0]!.split("-");
    const prerelease = pre.join("-");
    return { core: core.split(".").map((n) => Number(n) || 0), pre: prerelease ? prerelease.split(".") : [] };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length, 3); i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A pre-release comes before its release.
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // numeric identifiers come before alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

interface Latest {
  version: string;
  url: string | null;
  notes: string | null;
  publishedAt: number | null;
}

type Source = { kind: "github"; repo: string } | { kind: "manifest"; url: string };

/** GitHub Releases: the latest published release (drafts and pre-releases are skipped by GitHub). */
async function fromGithub(repo: string): Promise<Latest> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "EaglePanel update check" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const data = (await response.json()) as { tag_name?: unknown; html_url?: unknown; body?: unknown; published_at?: unknown };
  if (typeof data.tag_name !== "string" || !data.tag_name) throw new Error("The release has no tag");
  return {
    version: data.tag_name.replace(/^v/i, ""),
    url: typeof data.html_url === "string" ? data.html_url : null,
    notes: typeof data.body === "string" ? data.body.slice(0, MAX_NOTES) : null,
    publishedAt: typeof data.published_at === "string" ? Date.parse(data.published_at) || null : null,
  };
}

/** Any HTTPS URL that returns `{ "version": "...", "url": "...", "notes": "...", "publishedAt": "2026-11-16T22:15:00Z" }`. */
async function fromManifest(url: string): Promise<Latest> {
  const response = await fetch(url, { headers: { "user-agent": "EaglePanel update check" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`The update manifest answered ${response.status}`);
  const data = (await response.json()) as { version?: unknown; url?: unknown; notes?: unknown; publishedAt?: unknown };
  if (typeof data.version !== "string" || !data.version) throw new Error("The update manifest has no version");
  return {
    version: data.version.replace(/^v/i, ""),
    url: typeof data.url === "string" && data.url.startsWith("https://") ? data.url : null,
    notes: typeof data.notes === "string" ? data.notes.slice(0, MAX_NOTES) : null,
    publishedAt: typeof data.publishedAt === "string" ? Date.parse(data.publishedAt) || null : null,
  };
}

/** `EAGLEPANEL_UPDATE_URL` (a manifest) wins over `EAGLEPANEL_UPDATE_REPO`, which wins over the built-in repository. */
export function updateSourceFromEnv(env: Record<string, string | undefined> = process.env): Source | null {
  const url = env.EAGLEPANEL_UPDATE_URL?.trim();
  if (url) return url.startsWith("https://") ? { kind: "manifest", url } : null;
  const repo = (env.EAGLEPANEL_UPDATE_REPO?.trim() || DEFAULT_UPDATE_REPO).trim();
  return REPO_PATTERN.test(repo) ? { kind: "github", repo } : null;
}

export function createUpdateChecker({ current, source }: { current: string | null; source: Source | null }) {
  let status: UpdateStatusDto = {
    current,
    latest: null,
    updateAvailable: false,
    releaseUrl: null,
    notes: null,
    publishedAt: null,
    checkedAt: null,
    source: source?.kind ?? null,
    error: null,
  };
  let running: Promise<UpdateStatusDto> | null = null;

  async function check(): Promise<UpdateStatusDto> {
    if (!source) return status;
    running ??= (async () => {
      try {
        const latest = source.kind === "github" ? await fromGithub(source.repo) : await fromManifest(source.url);
        status = {
          ...status,
          latest: latest.version,
          // Without a VERSION file (development) there is nothing to compare: never shown as an update.
          updateAvailable: current !== null && compareVersions(latest.version, current) > 0,
          releaseUrl: latest.url,
          notes: latest.notes,
          publishedAt: latest.publishedAt,
          checkedAt: Date.now(),
          error: null,
        };
      } catch (error) {
        // The last known result is kept: a failed check does not hide an update already found.
        status = { ...status, checkedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
        console.error("[api] update check failed:", status.error);
      }
      return status;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    get: () => status,
    check,
    start() {
      if (!source) return () => {};
      const first = setTimeout(() => void check(), FIRST_CHECK_MS);
      const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
      return () => {
        clearTimeout(first);
        clearInterval(timer);
      };
    },
  };
}
