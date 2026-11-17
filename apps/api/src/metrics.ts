import type { MetricsPointDto, MetricsRange, SystemMetricsDto } from "@eaglepanel/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { dirname } from "node:path";

/** One CPU and memory sample every 15 s. */
export const METRICS_INTERVAL_MS = 15_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Raw samples cover the last 24 h; 5-minute averages, the last 7 days. */
const RAW_KEEP_MS = DAY;
const AGG_STEP_MS = 5 * MINUTE;
const AGG_KEEP_MS = 7 * DAY;

/** What each range returns: span and width of each point. */
const RANGES: Record<MetricsRange, { spanMs: number; stepMs: number; source: "raw" | "agg" }> = {
  "1h": { spanMs: HOUR, stepMs: MINUTE, source: "raw" },
  "24h": { spanMs: DAY, stepMs: 5 * MINUTE, source: "raw" },
  "7d": { spanMs: 7 * DAY, stepMs: HOUR, source: "agg" },
};

/** [timestamp, cpu %, memory %] — compact on disk. */
type Point = [number, number, number];

interface Store {
  v: 1;
  raw: Point[];
  agg: Point[];
}

const round1 = (value: number) => Math.round(value * 10) / 10;

function isPoint(value: unknown): value is Point {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

function load(file: string | undefined): Store {
  if (!file || !existsSync(file)) return { v: 1, raw: [], agg: [] };
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<Store>;
    return {
      v: 1,
      raw: Array.isArray(data.raw) ? data.raw.filter(isPoint) : [],
      agg: Array.isArray(data.agg) ? data.agg.filter(isPoint) : [],
    };
  } catch (error) {
    // A corrupt file only loses the history: the panel keeps measuring from now on.
    console.error("[api] could not read the metrics history, starting over:", error);
    return { v: 1, raw: [], agg: [] };
  }
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** Averages the points that fall in each `stepMs` bucket from `from` on. Empty buckets are skipped. */
function bucketize(points: Point[], from: number, stepMs: number): MetricsPointDto[] {
  const buckets = new Map<number, { cpu: number; memory: number; n: number }>();
  for (const [at, cpu, memory] of points) {
    if (at < from) continue;
    const key = from + Math.floor((at - from) / stepMs) * stepMs;
    const bucket = buckets.get(key) ?? { cpu: 0, memory: 0, n: 0 };
    bucket.cpu += cpu;
    bucket.memory += memory;
    bucket.n += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([at, { cpu, memory, n }]) => ({ at, cpu: round1(cpu / n), memory: round1(memory / n) }));
}

export interface MetricsDeps {
  /** JSON file with the history. Without it (tests), the history lives in memory only. */
  file?: string;
  now?: () => number;
}

/**
 * Measures CPU and memory of the server every 15 s and keeps the history in a JSON file next to the database,
 * so the overview can show the last hour, day or week. The API reads the same host counters as the agent.
 */
export function createMetricsMonitor({ file, now = Date.now }: MetricsDeps = {}) {
  const store = load(file);
  let previous = cpuTimes();

  function persist() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    // Written aside and renamed: a crash mid-write never leaves a half file.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    renameSync(tmp, file);
  }

  function sample(): Point {
    const at = now();
    const current = cpuTimes();
    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;
    previous = current;
    const cpu = totalDelta > 0 ? Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100)) : 0;
    const total = totalmem();
    const memory = total > 0 ? ((total - freemem()) / total) * 100 : 0;
    const point: Point = [at, round1(cpu), round1(memory)];

    // When a 5-minute bucket closes, its average goes to the 7-day history.
    const last = store.raw.at(-1);
    if (last && Math.floor(last[0] / AGG_STEP_MS) !== Math.floor(at / AGG_STEP_MS)) {
      const bucketStart = Math.floor(last[0] / AGG_STEP_MS) * AGG_STEP_MS;
      const inBucket = store.raw.filter(([t]) => t >= bucketStart && t < bucketStart + AGG_STEP_MS);
      if (inBucket.length > 0) {
        const avg = (i: 1 | 2) => round1(inBucket.reduce((sum, p) => sum + p[i], 0) / inBucket.length);
        store.agg.push([bucketStart, avg(1), avg(2)]);
      }
    }

    store.raw.push(point);
    store.raw = store.raw.filter(([t]) => t >= at - RAW_KEEP_MS);
    store.agg = store.agg.filter(([t]) => t >= at - AGG_KEEP_MS);
    return point;
  }

  function series(range: MetricsRange): SystemMetricsDto {
    const { spanMs, stepMs, source } = RANGES[range];
    const end = now();
    // Aligned to the step, so the points do not shift on every refresh.
    const from = Math.floor((end - spanMs) / stepMs) * stepMs;
    // The 7-day view also includes the samples of the bucket still open.
    const points = source === "agg" ? [...store.agg, ...store.raw.slice(-20)] : store.raw;
    return { range, intervalMs: stepMs, points: bucketize(points, from, stepMs) };
  }

  return {
    sample,
    series,
    start() {
      const timer = setInterval(() => {
        try {
          sample();
          persist();
        } catch (error) {
          console.error("[api] could not record metrics:", error);
        }
      }, METRICS_INTERVAL_MS);
      return () => clearInterval(timer);
    },
  };
}

export type MetricsMonitor = ReturnType<typeof createMetricsMonitor>;
