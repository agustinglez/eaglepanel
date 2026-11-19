import { useQuery } from "@tanstack/react-query";
import type { EnvironmentHealthDto, JobDto, SystemMetricsDto } from "@eaglepanel/shared";
import { api } from "@/lib/api";
import { useSystemInfo } from "@/lib/system-info";

const DAY_MS = 86_400_000;
const HIGH_USAGE = 90;

export interface SystemHealth {
  /** False until the agent and the environment checks have answered at least once. */
  ready: boolean;
  /** Each problem as a short sentence (English: translated where it is shown). */
  issues: { text: string; values?: Record<string, string | number>; severity: "warning" | "critical" }[];
}

/**
 * What "All systems healthy" means: the agent answers, no environment is down, CPU and memory are under 90 %,
 * and no job failed in the last 24 h. Same queries (and cache) as the overview.
 */
export function useSystemHealth(): SystemHealth {
  const info = useSystemInfo();
  const environments = useQuery({
    queryKey: ["environment-health"],
    queryFn: () => api.get<EnvironmentHealthDto[]>("/environments/health"),
    refetchInterval: 60_000,
  });
  const metrics = useQuery({
    queryKey: ["system-metrics", "1h"],
    queryFn: () => api.get<SystemMetricsDto>("/system/metrics?range=1h"),
    refetchInterval: 15_000,
  });
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api.get<JobDto[]>("/jobs") });

  const issues: SystemHealth["issues"] = [];
  if (info.isError) issues.push({ text: "The agent is not responding", severity: "critical" });

  const down = environments.data?.filter((e) => e.health === "down") ?? [];
  if (down.length === 1) issues.push({ text: "{{fqdn}} is down", values: { fqdn: down[0]!.name }, severity: "critical" });
  else if (down.length > 1) issues.push({ text: "{{count}} environments are down", values: { count: down.length }, severity: "critical" });

  const cpu = metrics.data?.points.at(-1)?.cpu;
  if (cpu !== undefined && cpu >= HIGH_USAGE) issues.push({ text: "CPU at {{value}}%", values: { value: cpu.toFixed(0) }, severity: "warning" });

  const memory = info.data?.memory;
  if (memory && memory.totalBytes > 0) {
    const pct = ((memory.totalBytes - memory.freeBytes) / memory.totalBytes) * 100;
    if (pct >= HIGH_USAGE) issues.push({ text: "Memory at {{value}}%", values: { value: pct.toFixed(0) }, severity: "warning" });
  }

  const since = Date.now() - DAY_MS;
  const failed = jobs.data?.filter((j) => j.createdAt >= since && ["failed", "rollback_failed", "interrupted"].includes(j.status)).length ?? 0;
  if (failed > 0) issues.push({ text: "{{count}} jobs failed in the last 24 h", values: { count: failed }, severity: "warning" });

  return { ready: (info.isSuccess || info.isError) && (environments.isSuccess || environments.isError), issues };
}
