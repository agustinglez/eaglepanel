import { Outlet, useRouterState } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AppSidebar } from "@/components/app-sidebar";
import { UpdatesBanner, UpdatesDialog } from "@/components/updates-notice";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSystemHealth } from "@/lib/system-health";
import { useSystemInfo } from "@/lib/system-info";

export { useSystemInfo };

function titleFor(pathname: string): string {
  if (pathname === "/") return "Overview";
  if (pathname === "/accounts/new") return "New account";
  if (pathname.startsWith("/accounts/")) {
    const parts = pathname.slice("/accounts/".length).split("/");
    // /accounts/<user>/<tab> is the account page (title: the username); /accounts/<user>/environments/<slug> and
    // /accounts/<user>/domains/<domain>, an environment or a domain (title: its slug or its name).
    return decodeURIComponent(parts.length === 3 && (parts[1] === "environments" || parts[1] === "domains") ? parts[2]! : parts.length === 2 ? parts[0]! : parts.join("/"));
  }
  if (pathname.startsWith("/accounts")) return "Accounts";
  if (pathname.startsWith("/jobs")) return "Jobs";
  if (pathname.startsWith("/activity")) return "Activity";
  if (pathname.startsWith("/updates")) return "Updates";
  if (pathname.startsWith("/settings")) return "Settings";
  return "EaglePanel";
}

/** "All systems healthy" only when nothing is wrong: see useSystemHealth for what is checked. */
function HealthStatus() {
  const { t } = useTranslation();
  const { ready, issues } = useSystemHealth();
  if (!ready) return null;
  if (issues.length === 0) {
    return (
      <span className="hidden items-center gap-1.5 text-xs text-foreground/60 sm:flex">
        <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
        {t("All systems healthy")}
      </span>
    );
  }
  const critical = issues.some((issue) => issue.severity === "critical");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={`flex items-center gap-1.5 rounded-ep-chip px-2 py-1 text-xs ${critical ? "bg-destructive/15 text-destructive" : "bg-warning-muted text-warning"}`}
          />
        }
      >
        <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
        {issues.length === 1 ? t(issues[0]!.text, issues[0]!.values ?? {}) : t("{{count}} issues", { count: issues.length })}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end">
        <ul className="flex flex-col gap-1">
          {issues.map((issue, i) => (
            <li key={i}>{t(issue.text, issue.values ?? {})}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/** Top bar: breadcrumb (server / page) and the server status. */
function SiteHeader() {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const info = useSystemInfo();

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b border-white/10">
      <div className="flex w-full items-center gap-1 px-5 lg:gap-2 lg:px-7">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 h-4 data-vertical:self-auto" />
        <nav aria-label={t("Breadcrumb")} className="flex min-w-0 items-center gap-2 text-sm">
          <span className="hidden truncate text-foreground/45 sm:inline">{info.data?.hostname ?? "EaglePanel"}</span>
          <span className="hidden text-foreground/25 sm:inline" aria-hidden="true">/</span>
          <h1 className="truncate font-sans text-sm font-normal">{t(titleFor(pathname))}</h1>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {info.data?.sandbox && <Badge variant="outline">Sandbox</Badge>}
          <HealthStatus />
        </div>
      </div>
    </header>
  );
}

export function AppShell() {
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 56)",
          "--header-height": "calc(var(--spacing) * 16)",
        } as CSSProperties
      }
    >
      <AppSidebar />
      <SidebarInset>
        <SiteHeader />
        <UpdatesBanner />
        <UpdatesDialog />
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-2">
            <Outlet />
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-5 p-4 sm:p-6 lg:p-7">{children}</div>;
}
