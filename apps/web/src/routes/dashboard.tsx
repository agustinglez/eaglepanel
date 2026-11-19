import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { AccountDto, EnvironmentHealth, EnvironmentHealthDto, JobDto, JobStatus, MetricsPointDto, MetricsRange, SystemMetricsDto } from "@eaglepanel/shared";
import {
  BoxIcon,
  CheckIcon,
  CpuIcon,
  GlobeIcon,
  LoaderCircleIcon,
  MemoryStickIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  UserIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Page, useSystemInfo } from "@/components/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useCheckForUpdates, useUpdateStatus } from "@/lib/update-status";
import { formatBytes, formatDateTime } from "@/lib/format";
import { currentLocale, serverText } from "@/lib/i18n";

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(currentLocale(), { dateStyle: "medium" }).format(timestamp);
}

/* ---------- KPI cards ---------- */

type Tone = "success" | "warning" | "destructive" | "muted";

const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-foreground/45",
};

function StatCard({
  label,
  value,
  unit,
  icon: Icon,
  status,
  tone = "muted",
}: {
  label: string;
  value: string;
  unit?: string;
  icon: LucideIcon;
  status: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-ep-card border border-border bg-card p-4">
      <div className="flex items-center justify-between text-foreground/45">
        <span className="text-xs">{label}</span>
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div className="mt-4 flex items-baseline gap-2">
        <span className="font-mono text-3xl tracking-tight text-white">{value}</span>
        {unit && <span className="text-sm text-foreground/45">{unit}</span>}
      </div>
      <div className={`mt-3 flex items-center gap-1.5 text-xs ${TONE_TEXT[tone]}`}>
        {tone !== "muted" && <span className="size-1 rounded-full bg-current" aria-hidden="true" />}
        <span className="truncate">{status}</span>
      </div>
    </div>
  );
}

/* ---------- Resource activity (history recorded by the API every 15 s) ---------- */

const RANGES: { id: MetricsRange; label: string }[] = [
  { id: "1h", label: "1H" },
  { id: "24h", label: "24H" },
  { id: "7d", label: "7D" },
];

export function useMetrics(range: MetricsRange) {
  return useQuery({
    queryKey: ["system-metrics", range],
    queryFn: () => api.get<SystemMetricsDto>(`/system/metrics?range=${range}`),
    refetchInterval: 15_000,
  });
}

const W = 600;
const H = 145;

/** SVG path of one series over the span of the range: the newest point on the right edge. */
function linePath(points: MetricsPointDto[], key: "cpu" | "memory", from: number, to: number): string {
  if (points.length < 2) return "";
  const x = (at: number) => ((at - from) / (to - from)) * W;
  const y = (v: number) => H - (Math.min(Math.max(v, 0), 100) / 100) * (H - 1);
  return points.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)} ${y(p[key]).toFixed(1)}`).join("");
}

const SPAN: Record<MetricsRange, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 };

function axisLabels(range: MetricsRange, from: number, to: number): string[] {
  const locale = currentLocale();
  const fmt =
    range === "7d"
      ? new Intl.DateTimeFormat(locale, { weekday: "short" })
      : new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  return Array.from({ length: 5 }, (_, i) => fmt.format(from + ((to - from) * i) / 4));
}

function ResourceActivity() {
  const { t } = useTranslation();
  const [range, setRange] = useState<MetricsRange>("1h");
  const metrics = useMetrics(range);
  const points = metrics.data?.points ?? [];
  const to = metrics.dataUpdatedAt || Date.now();
  const from = to - SPAN[range];
  const cpuLine = linePath(points, "cpu", from, to);
  const memLine = linePath(points, "memory", from, to);
  const firstX = points.length ? (((points[0]!.at - from) / (to - from)) * W).toFixed(1) : "0";
  const last = points.at(-1);

  return (
    <div className="rounded-ep-card border border-white/10 bg-card p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-sans text-sm font-normal text-foreground/85">{t("Resource activity")}</h4>
        <div className="flex rounded-ep border border-white/10 p-0.5" role="group" aria-label={t("Chart time range")}>
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
              className={`rounded-ep-chip px-2 py-1 font-mono text-xs ${range === r.id ? "bg-white/10 text-white" : "text-foreground/45"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-4 text-xs text-foreground/45">
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-lilac" />
          CPU <span className="text-foreground/80">{last ? `${last.cpu.toFixed(1)}%` : "—"}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-[#6b6890]" />
          {t("Memory")} <span className="text-foreground/80">{last ? `${last.memory.toFixed(1)}%` : "—"}</span>
        </span>
      </div>
      <div className="relative mt-4 h-36 pl-7">
        <div className="absolute top-0 bottom-0 left-0 flex flex-col justify-between font-mono text-xs text-foreground/30">
          <span>100</span>
          <span>50</span>
          <span>0</span>
        </div>
        {metrics.isError ? (
          <div className="flex h-full items-center justify-center text-xs text-destructive">{metrics.error.message}</div>
        ) : points.length < 2 ? (
          <div className="flex h-full items-center justify-center rounded-ep border border-dashed border-white/10 text-xs text-foreground/45">
            {metrics.isPending ? t("Loading…") : t("Collecting data. The first points appear within a minute.")}
          </div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible" role="img" aria-label={t("CPU and memory usage chart")}>
            <defs>
              <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
                <stop stopColor="#6331FB" stopOpacity=".45" />
                <stop offset="1" stopColor="#6331FB" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={`M0 1H${W}M0 72H${W}M0 144H${W}`} stroke="#ffffff" strokeOpacity=".07" strokeDasharray="3 5" />
            <path d={memLine} stroke="#6b6890" strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke" />
            <path d={`${cpuLine}V145H${firstX}Z`} fill="url(#chart-fill)" />
            <path d={cpuLine} stroke="#CDBDFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </div>
      <div className="ml-7 mt-3 flex justify-between font-mono text-xs text-foreground/30">
        {axisLabels(range, from, to).map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>
    </div>
  );
}

/* ---------- Latest activity (recent jobs) ---------- */

function relativeTime(timestamp: number, now: number): string {
  const s = Math.max(0, Math.round((now - timestamp) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function JobIcon({ status }: { status: JobStatus }) {
  if (status === "succeeded")
    return (
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-mint/10 text-mint">
        <CheckIcon className="size-3.5" aria-hidden="true" />
      </span>
    );
  if (status === "running" || status === "pending")
    return (
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/5 text-foreground/60">
        <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
      </span>
    );
  if (status === "rolled_back")
    return (
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-warning-muted text-warning">
        <RefreshCwIcon className="size-3.5" aria-hidden="true" />
      </span>
    );
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
      <XIcon className="size-3.5" aria-hidden="true" />
    </span>
  );
}

function LatestActivity({ jobs }: { jobs: ReturnType<typeof useJobs> }) {
  const { t } = useTranslation();
  const now = Date.now();
  return (
    <div className="rounded-ep-card border border-border bg-card p-4 sm:p-5">
      <div className="mb-5 flex items-center justify-between">
        <h3 className="font-sans text-sm font-normal text-foreground/85">{t("Latest activity")}</h3>
        <Link to="/jobs" className="font-mono text-xs text-foreground/30 transition hover:text-foreground/70">{t("View all")}</Link>
      </div>
      {jobs.isPending && <Skeleton className="h-40 w-full" />}
      {jobs.isError && <p className="text-sm text-destructive">{jobs.error.message}</p>}
      {jobs.data?.length === 0 && <p className="text-sm text-foreground/45">{t("No jobs have run yet.")}</p>}
      {jobs.data && jobs.data.length > 0 && (
        <ul className="space-y-5">
          {jobs.data.slice(0, 4).map((job) => (
            <li key={job.id} className="flex gap-3">
              <JobIcon status={job.status} />
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground/85">{serverText(job.title)}</p>
                <p className="mt-1 truncate text-xs text-foreground/45">{formatDateTime(job.createdAt)}</p>
              </div>
              <span className="ml-auto shrink-0 pt-1 font-mono text-xs text-foreground/30">{relativeTime(job.createdAt, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- Environments ---------- */

export function useEnvironmentHealth() {
  return useQuery({
    queryKey: ["environment-health"],
    queryFn: () => api.get<EnvironmentHealthDto[]>("/environments/health"),
    refetchInterval: 60_000,
  });
}

const HEALTH: Record<EnvironmentHealth, { label: string; className: string }> = {
  online: { label: "Online", className: "bg-mint/10 text-mint" },
  down: { label: "Down", className: "bg-destructive/15 text-destructive" },
  inactive: { label: "Inactive", className: "bg-white/5 text-foreground/55" },
  suspended: { label: "Suspended", className: "bg-warning-muted text-warning" },
  deploying: { label: "Deploying", className: "bg-primary/20 text-lilac" },
  unknown: { label: "Not checked", className: "bg-white/5 text-foreground/45" },
};

const DAY_MS = 86_400_000;

function EnvironmentsTable({ accounts, health }: { accounts: ReturnType<typeof useAccounts>; health: ReturnType<typeof useEnvironmentHealth> }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const byId = new Map<number, EnvironmentHealthDto>((health.data ?? []).map((h) => [h.id, h]));
  const now = Date.now();
  const rows = (accounts.data ?? [])
    .flatMap((account) => account.vhosts.map((vhost) => ({ account, vhost })))
    .filter(({ account, vhost }) => !q || [vhost.name, vhost.hostname, vhost.slug, account.username].some((text) => text.toLowerCase().includes(q)))
    .sort((a, b) => a.vhost.name.localeCompare(b.vhost.name));
  const total = accounts.data?.reduce((n, a) => n + a.vhosts.length, 0) ?? 0;

  return (
    <div className="overflow-hidden rounded-ep-card border border-white/10 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-4 sm:px-5">
        <div className="flex items-center gap-2">
          <h4 className="font-sans text-sm font-normal text-foreground/85">{t("Environments")}</h4>
          {accounts.data && <span className="rounded-ep-chip bg-white/5 px-1.5 py-0.5 font-mono text-xs text-foreground/45">{total}</span>}
        </div>
        <label className="flex items-center gap-2 text-foreground/45">
          <SearchIcon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{t("Find an environment")}</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="app.example.com"
            className="w-32 bg-transparent text-xs text-foreground outline-none placeholder:text-foreground/30 sm:w-40"
          />
        </label>
      </div>
      {accounts.isPending && <Skeleton className="m-4 h-32" />}
      {accounts.isError && <p className="p-5 text-sm text-destructive">{accounts.error.message}</p>}
      {accounts.data && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-white/5 text-xs text-foreground/35">
              <tr>
                <th className="px-5 py-3 font-normal">{t("Environment")}</th>
                <th className="px-3 py-3 font-normal">{t("Status")}</th>
                <th className="px-3 py-3 font-normal">{t("Runtime")}</th>
                <th className="px-3 py-3 font-normal">{t("Response")}</th>
                <th className="px-3 py-3 font-normal">{t("SSL certificate")}</th>
                <th className="px-4 py-3 text-right font-normal">{t("Account")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map(({ account, vhost }) => {
                const h = byId.get(vhost.id);
                const state = HEALTH[h?.health ?? "unknown"];
                const cert = vhost.certZone ? account.domains.find((d) => d.fqdn === vhost.certZone)?.certificate ?? undefined : undefined;
                const daysLeft = cert ? Math.floor((cert.notAfter - now) / DAY_MS) : null;
                const isApp = vhost.type === "app";
                return (
                  <tr key={vhost.id} className="transition hover:bg-white/[0.025]">
                    <td className="px-5 py-3.5">
                      <Link to="/accounts/$username/environments/$id" params={{ username: account.username, id: String(vhost.id) }} className="flex items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-ep-chip border border-white/10 bg-white/[0.02] text-foreground/45">
                          {isApp ? <BoxIcon className="size-4" aria-hidden="true" /> : <GlobeIcon className="size-4" aria-hidden="true" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-foreground/85">{vhost.name}</span>
                          <span className="mt-1 block truncate font-mono text-xs text-foreground/35">{vhost.hostname}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-3.5">
                      <span className={`inline-flex items-center gap-1.5 rounded-ep-chip px-2 py-1 text-xs ${state.className}`}>
                        <span className="size-1 rounded-full bg-current" aria-hidden="true" />
                        {t(state.label)}
                      </span>
                    </td>
                    <td className="px-3 py-3.5 font-mono text-xs text-foreground/60">
                      {isApp ? (vhost.app ? `${vhost.app.config.runtime} ${vhost.app.config.runtimeVersion}` : "App") : `PHP ${vhost.phpVersion}`}
                    </td>
                    <td className="px-3 py-3.5 font-mono text-xs text-foreground/60">
                      {h?.responseMs != null ? `${h.responseMs} ms` : "—"}
                      {h?.httpStatus != null && <span className="ml-1.5 text-foreground/35">{h.httpStatus}</span>}
                    </td>
                    <td className="px-3 py-3.5 text-xs">
                      {!cert ? (
                        <span className="text-warning">{t("No certificate")}</span>
                      ) : daysLeft !== null && daysLeft < 30 ? (
                        <span className="text-warning">{t("Expires in {{count}} days", { count: Math.max(daysLeft, 0) })}</span>
                      ) : (
                        <span className="font-mono text-foreground/60">{t("Until {{date}}", { date: formatDate(cert.notAfter) })}</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-xs text-foreground/45">{account.username}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="p-6 text-center text-sm text-foreground/45">
              {total === 0 ? t("No environments yet.") : t("No environments match your search.")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Accounts table ---------- */



function AccountsTable({ accounts }: { accounts: ReturnType<typeof useAccounts> }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const rows = (accounts.data ?? []).filter(
    (a) => !q || a.username.toLowerCase().includes(q) || a.domains.some((d) => d.hostnames.some((h) => h.fqdn.includes(q))),
  );

  return (
    <div className="overflow-hidden rounded-ep-card border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div className="flex items-center gap-2">
          <h3 className="font-sans text-sm font-normal text-foreground/85">{t("Accounts")}</h3>
          {accounts.data && <span className="rounded-ep-chip bg-white/5 px-1.5 py-0.5 font-mono text-xs text-foreground/45">{accounts.data.length}</span>}
        </div>
        <label className="flex items-center gap-2 text-foreground/45">
          <SearchIcon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{t("Find an account")}</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="example.com"
            className="w-32 bg-transparent text-xs text-foreground outline-none placeholder:text-foreground/30 sm:w-40"
          />
        </label>
      </div>
      {accounts.isPending && <Skeleton className="m-4 h-32" />}
      {accounts.isError && <p className="p-5 text-sm text-destructive">{accounts.error.message}</p>}
      {accounts.data && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[650px] text-left text-sm">
            <thead className="border-b border-white/5 text-xs text-foreground/35">
              <tr>
                <th className="px-5 py-3 font-normal">{t("Account")}</th>
                <th className="px-3 py-3 font-normal">{t("Status")}</th>
                <th className="px-3 py-3 font-normal">{t("Environments")}</th>
                <th className="px-3 py-3 font-normal">{t("Databases")}</th>
                <th className="px-4 py-3 text-right font-normal">{t("Created")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((account) => (
                <tr key={account.username} className="transition hover:bg-white/[0.025]">
                  <td className="px-5 py-3.5">
                    <Link to="/accounts/$username" params={{ username: account.username }} className="flex items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-ep-chip border border-white/10 bg-white/[0.02] text-foreground/45">
                        <UserIcon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-foreground/85">{account.username}</span>
                        <span className="mt-1 block truncate font-mono text-xs text-foreground/35">{account.domains.map(({ fqdn }) => fqdn).join(", ") || "—"}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-3.5">
                    {account.suspended || account.dbBlocked ? (
                      <span className="inline-flex items-center gap-1.5 rounded-ep-chip bg-warning-muted px-2 py-1 text-xs text-warning">
                        <span className="size-1 rounded-full bg-current" aria-hidden="true" />
                        {account.suspended ? t("Suspended") : t("Databases blocked")}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-ep-chip bg-mint/10 px-2 py-1 text-xs text-mint">
                        <span className="size-1 rounded-full bg-current" aria-hidden="true" />
                        {t("Active")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3.5 font-mono text-xs text-foreground/60">{account.vhosts.length}</td>
                  <td className="px-3 py-3.5 font-mono text-xs text-foreground/60">{account.databases.length}</td>
                  <td className="px-4 py-3.5 text-right font-mono text-xs text-foreground/45">{formatDate(account.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="p-6 text-center text-sm text-foreground/45">
              {accounts.data.length === 0 ? t("No accounts yet.") : t("No accounts match your search.")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Version ---------- */

function VersionInfo() {
  const { t } = useTranslation();
  const status = useUpdateStatus();
  const check = useCheckForUpdates();
  const data = status.data;
  return (
    <span className="flex items-center gap-3">
      {data?.updateAvailable && data.releaseUrl ? (
        <a href={data.releaseUrl} target="_blank" rel="noreferrer noopener" className="text-lilac transition hover:text-white">
          {t("Version {{version}} available", { version: data.latest })}
        </a>
      ) : (
        data?.source && (
          <button
            type="button"
            disabled={check.isPending}
            onClick={() => check.mutate()}
            className="transition hover:text-foreground/70 disabled:opacity-50"
            title={data.error ? t("Last check failed: {{error}}", { error: data.error }) : undefined}
          >
            {check.isPending ? t("Checking…") : t("Check for updates")}
          </button>
        )
      )}
      <span className="font-mono uppercase">EaglePanel {data?.current ? `v${data.current}` : "dev"}</span>
    </span>
  );
}

/* ---------- Page ---------- */

function useAccounts() {
  return useQuery({ queryKey: ["accounts"], queryFn: () => api.get<AccountDto[]>("/accounts") });
}

function useJobs() {
  return useQuery({ queryKey: ["jobs"], queryFn: () => api.get<JobDto[]>("/jobs") });
}

export function DashboardPage() {
  const { t } = useTranslation();
  const info = useSystemInfo();
  const accounts = useAccounts();
  const jobs = useJobs();
  const health = useEnvironmentHealth();
  const metrics = useMetrics("1h");

  const vhosts = accounts.data?.flatMap((account) => account.vhosts) ?? [];
  const down = health.data?.filter((h) => h.health === "down").length ?? 0;
  const online = health.data?.filter((h) => h.health === "online").length ?? 0;
  const memory = info.data?.memory;
  const usedBytes = memory ? memory.totalBytes - memory.freeBytes : 0;
  const memoryPct = memory && memory.totalBytes > 0 ? (usedBytes / memory.totalBytes) * 100 : null;
  const cpuPoints = metrics.data?.points ?? [];
  const cpuNow = cpuPoints.at(-1)?.cpu ?? null;
  const cpuAvg = cpuPoints.length ? cpuPoints.reduce((sum, p) => sum + p.cpu, 0) / cpuPoints.length : null;

  return (
    <Page>
      {info.isError && (
        <Alert variant="destructive">
          <AlertTitle>{t("Agent not responding")}</AlertTitle>
          <AlertDescription>{t("Operations cannot run until it is back.")}</AlertDescription>
        </Alert>
      )}

      <div className="mb-1 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl leading-none font-semibold text-white">{t("A bird’s-eye view")}</h2>
          <p className="mt-2 text-sm text-foreground/50">
            {info.isError ? t("The agent is not responding.") : t("Here’s your server at a glance.")}
          </p>
        </div>
        <Link
          to="/accounts/new"
          className="flex items-center gap-2 rounded-ep bg-primary px-4 py-2.5 text-sm text-white transition hover:bg-[#5226e0] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <PlusIcon className="size-4" aria-hidden="true" />
          {t("New account")}
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 @5xl/main:grid-cols-4">
        <StatCard
          label={t("Accounts")}
          icon={UsersIcon}
          value={accounts.data ? String(accounts.data.length).padStart(2, "0") : "—"}
          tone={accounts.data ? "success" : "muted"}
          status={accounts.data ? t("{{count}} suspended", { count: accounts.data.filter((a) => a.suspended).length }) : t("No data")}
        />
        <StatCard
          label={t("Environments online")}
          icon={GlobeIcon}
          value={health.data ? String(online).padStart(2, "0") : "—"}
          unit={accounts.data ? `/ ${vhosts.length}` : undefined}
          tone={!health.data ? "muted" : down > 0 ? "destructive" : "success"}
          status={!health.data ? t("Checking…") : down > 0 ? t("{{count}} down", { count: down }) : t("None down")}
        />
        <StatCard
          label={t("CPU usage")}
          icon={CpuIcon}
          value={cpuNow === null ? "—" : cpuNow.toFixed(1)}
          unit={cpuNow === null ? undefined : "%"}
          tone={cpuNow === null ? "muted" : cpuNow >= 90 ? "warning" : "success"}
          status={cpuAvg === null ? t("Collecting data") : t("{{avg}}% average, last hour", { avg: cpuAvg.toFixed(1) })}
        />
        <StatCard
          label={t("Memory in use")}
          icon={MemoryStickIcon}
          value={memoryPct === null ? "—" : memoryPct.toFixed(1)}
          unit={memoryPct === null ? undefined : "%"}
          tone={info.isError ? "destructive" : memoryPct !== null && memoryPct >= 90 ? "warning" : "muted"}
          status={memory ? `${formatBytes(usedBytes)} ${t("of {{total}}", { total: formatBytes(memory.totalBytes) })}` : t("No data")}
        />
      </div>

      <div className="grid gap-4 @5xl/main:grid-cols-[1.65fr_1fr]">
        <ResourceActivity />
        <LatestActivity jobs={jobs} />
      </div>

      <EnvironmentsTable accounts={accounts} health={health} />

      <AccountsTable accounts={accounts} />

      <div className="-mt-1 flex items-center justify-between gap-3 text-xs text-foreground/35">
        <span className="flex items-center gap-1.5">
          <RefreshCwIcon className="size-3" aria-hidden="true" />
          {info.dataUpdatedAt ? t("Last synced {{time}}", { time: formatDateTime(info.dataUpdatedAt) }) : t("Not synced yet")}
        </span>
        <VersionInfo />
      </div>
    </Page>
  );
}
