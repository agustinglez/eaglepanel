import { useQueryClient } from "@tanstack/react-query";
import type { JobCreatedDto, SystemPackageDto, VulnerabilitySeverity } from "@eaglepanel/shared";
import { ArrowUpRightIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Page } from "@/components/app-shell";
import { ActionFeedback, useJobAction } from "@/components/job-action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { serverText } from "@/lib/i18n";
import { useCheckPackages, usePackagesStatus } from "@/lib/system-packages";
import { useCheckForUpdates, useUpdateStatus } from "@/lib/update-status";

const SEVERITY_LABELS: Record<VulnerabilitySeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  negligible: "Negligible",
  unknown: "Unrated",
};

function SeverityBadge({ severity }: { severity: VulnerabilitySeverity }) {
  const { t } = useTranslation();
  const variant = severity === "critical" || severity === "high" ? "destructive" : severity === "medium" ? "warning" : "outline";
  return <Badge variant={variant}>{t(SEVERITY_LABELS[severity])}</Badge>;
}

/** The panel itself: updated on the server with `eagle upgrade`, never from the panel. */
function PanelCard() {
  const { t } = useTranslation();
  const status = useUpdateStatus();
  const check = useCheckForUpdates();
  const data = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>EaglePanel</CardTitle>
        <CardDescription>
          {data?.checkedAt ? t("Last checked {{date}}", { date: formatDateTime(data.checkedAt) }) : t("Not checked yet")}
        </CardDescription>
        {data?.source && (
          <CardAction>
            <Button variant="outline" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
              <RefreshCwIcon className={check.isPending ? "animate-spin" : undefined} />
              {check.isPending ? t("Checking…") : t("Check for updates")}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {status.isPending && <Skeleton className="h-10 w-full" />}
        {data && (
          <p>
            {t("Installed:")} <span className="font-mono">{data.current ? `v${data.current}` : "dev"}</span>
            {data.latest && (
              <>
                {" · "}
                {t("Latest:")} <span className="font-mono">v{data.latest}</span>
              </>
            )}
          </p>
        )}
        {data?.updateAvailable && (
          <Alert>
            <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                {t("Update it on the server with")} <code className="font-mono">sudo eagle upgrade</code>
              </span>
              {data.releaseUrl && (
                <a href={data.releaseUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary hover:underline">
                  {t("View release")}
                  <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
                </a>
              )}
            </AlertDescription>
          </Alert>
        )}
        {data?.error && <p className="text-xs text-destructive">{t("Last check failed: {{error}}", { error: data.error })}</p>}
      </CardContent>
    </Card>
  );
}

function UpgradeDialog({ pkg, onClose }: { pkg: SystemPackageDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const action = useJobAction((id: string) => api.post<JobCreatedDto>(`/system/packages/${id}/upgrade`));
  const restarts = pkg?.id === "openlitespeed" || pkg?.id === "php";
  return (
    <Dialog
      open={pkg !== null}
      onOpenChange={(next) => {
        if (!next) {
          action.reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Update {{name}}", { name: pkg?.name ?? "" })}</DialogTitle>
          <DialogDescription>
            {restarts
              ? t("The packages below are installed with apt and OpenLiteSpeed restarts gracefully: open connections finish first.")
              : t("The packages below are installed with apt. The configuration files are kept.")}
          </DialogDescription>
        </DialogHeader>
        {pkg && (
          <ul className="flex flex-col gap-1 rounded-ep border p-3 font-mono text-xs">
            {pkg.pending.map((p) => (
              <li key={p.name} className="break-all">
                {p.name} <span className="text-muted-foreground">{p.installed} → </span>
                {p.candidate}
              </li>
            ))}
          </ul>
        )}
        <ActionFeedback action={action} onFinished={() => void queryClient.invalidateQueries({ queryKey: ["system-packages"] })} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {action.jobId ? t("Close") : t("Cancel")}
          </Button>
          {!action.jobId && (
            <Button disabled={!pkg || action.isPending} onClick={() => pkg && action.mutate(pkg.id)}>
              {t("Update")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PackagesCard() {
  const { t } = useTranslation();
  const status = usePackagesStatus();
  const check = useCheckPackages();
  const [upgrading, setUpgrading] = useState<SystemPackageDto | null>(null);
  const data = status.data;
  const busy = check.isPending || data?.checking;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("System packages")}</CardTitle>
        <CardDescription>
          {data?.checkedAt
            ? t("Checked every 30 minutes. Last checked {{date}}.", { date: formatDateTime(data.checkedAt) })
            : t("Checked every 30 minutes. The first check runs shortly after the panel starts.")}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => check.mutate()}>
            <RefreshCwIcon className={busy ? "animate-spin" : undefined} />
            {busy ? t("Checking…") : t("Check now")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {data?.error && (
          <Alert variant="destructive">
            <AlertDescription>{serverText(data.error)}</AlertDescription>
          </Alert>
        )}
        {status.isPending && <Skeleton className="h-40 w-full" />}
        {status.isError && <p className="text-sm text-destructive">{status.error.message}</p>}
        {data && data.packages.length === 0 && !data.checking && <p className="text-sm text-muted-foreground">{t("No check has finished yet.")}</p>}
        {data && data.packages.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead>{t("Component")}</TableHead>
                  <TableHead>{t("Installed")}</TableHead>
                  <TableHead>{t("Available")}</TableHead>
                  <TableHead>{t("Vulnerabilities")}</TableHead>
                  <TableHead className="text-right">{t("Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.packages.map((pkg) => {
                  const worst = pkg.vulnerabilities[0];
                  return (
                    <TableRow key={pkg.id}>
                      <TableCell className="font-medium">{pkg.name}</TableCell>
                      <TableCell className="font-mono text-xs">{pkg.version}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {pkg.available ? <span className="text-primary">{pkg.available}</span> : <span className="font-sans text-muted-foreground">{t("Up to date")}</span>}
                      </TableCell>
                      <TableCell>
                        {pkg.cveSource === null ? (
                          <span className="text-xs text-muted-foreground">{t("Not tracked")}</span>
                        ) : worst ? (
                          <a href={`#cve-${pkg.id}`} className="inline-flex items-center gap-2 text-xs">
                            <SeverityBadge severity={worst.severity} />
                            {pkg.vulnerabilities.length}
                          </a>
                        ) : (
                          <Badge variant="success">{t("None known")}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {pkg.managedBy === "installer" ? (
                          <span className="text-xs text-muted-foreground">{t("With eagle upgrade")}</span>
                        ) : (
                          <Button size="sm" variant={pkg.pending.length ? "default" : "outline"} disabled={!pkg.pending.length} onClick={() => setUpgrading(pkg)}>
                            {t("Update")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      <UpgradeDialog pkg={upgrading} onClose={() => setUpgrading(null)} />
    </Card>
  );
}

function VulnerabilitiesCard() {
  const { t } = useTranslation();
  const status = usePackagesStatus();
  const data = status.data;
  const affected = data?.packages.filter((p) => p.vulnerabilities.length > 0) ?? [];
  if (!data) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Known vulnerabilities")}</CardTitle>
        <CardDescription>
          {t("Distribution packages are checked against OSV (Ubuntu and Debian security data); OpenLiteSpeed, PHP and Oracle's MySQL against NVD.")}
          {data.cveCheckedAt && ` ${t("Last checked {{date}}", { date: formatDateTime(data.cveCheckedAt) })}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data.cveError && (
          <Alert variant="destructive">
            <AlertDescription>{t("A vulnerability source did not answer: {{error}}", { error: data.cveError })}</AlertDescription>
          </Alert>
        )}
        {affected.length === 0 && <p className="text-sm text-muted-foreground">{t("No known vulnerabilities in the installed versions.")}</p>}
        {affected.map((pkg) => (
          <section key={pkg.id} id={`cve-${pkg.id}`} className="flex scroll-mt-20 flex-col gap-2">
            <h3 className="text-sm font-medium">
              {pkg.name} <span className="font-mono text-xs text-muted-foreground">{pkg.version}</span>
            </h3>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader className="bg-muted">
                  <TableRow>
                    <TableHead>CVE</TableHead>
                    <TableHead>{t("Severity")}</TableHead>
                    <TableHead>{t("Fixed in")}</TableHead>
                    <TableHead>{t("Details")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pkg.vulnerabilities.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="whitespace-nowrap">
                        <a href={v.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
                          {v.id}
                          <ArrowUpRightIcon className="size-3" aria-hidden="true" />
                        </a>
                      </TableCell>
                      <TableCell><SeverityBadge severity={v.severity} /></TableCell>
                      <TableCell className="font-mono text-xs">
                        {v.fixedIn ?? <span className="font-sans text-muted-foreground">{t("No fix published")}</span>}
                        {v.fixReachable === false && (
                          <span className="mt-0.5 block font-sans text-warning" title={t("The distribution already published it, but this server's apt mirror does not have it yet. It usually arrives within hours.")}>
                            {t("Not yet in this server's repositories")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-xl text-xs whitespace-normal text-muted-foreground">{v.summary ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}

export function UpdatesPage() {
  return (
    <Page>
      <PanelCard />
      <PackagesCard />
      <VulnerabilitiesCard />
    </Page>
  );
}
