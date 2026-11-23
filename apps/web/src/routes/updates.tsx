import { useQueryClient } from "@tanstack/react-query";
import type { JobCreatedDto, SystemPackageDto, UpdateStatusDto, VulnerabilitySeverity } from "@eaglepanel/shared";
import { ArrowUpRightIcon, CheckCircle2Icon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Page } from "@/components/app-shell";
import { ActionFeedback, useJobAction } from "@/components/job-action";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { useCheckForUpdates, usePanelUpgrade, useStartPanelUpgrade, useUpdateStatus } from "@/lib/update-status";

const SEVERITY_LABELS: Record<VulnerabilitySeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  negligible: "Negligible",
  unknown: "Unrated",
};

export function SeverityBadge({ severity }: { severity: VulnerabilitySeverity }) {
  const { t } = useTranslation();
  const variant = severity === "critical" || severity === "high" ? "destructive" : severity === "medium" ? "warning" : "outline";
  return <Badge variant={variant}>{t(SEVERITY_LABELS[severity])}</Badge>;
}

function UpgradeLog({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return <pre className="max-h-64 overflow-auto rounded-ep border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{lines.join("\n")}</pre>;
}

/** Runs `eagle upgrade` on the server through the agent, then follows it while the panel restarts. */
function PanelUpgrade({ data }: { data: UpdateStatusDto }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const { progress, following } = usePanelUpgrade();
  const start = useStartPanelUpgrade();
  const run = progress.data;
  const finished = following && run && !run.running && run.startedAt !== null;

  // Done: the new version is a new web bundle too, so the page is loaded again.
  useEffect(() => {
    if (finished && run.exitCode === 0) window.location.reload();
  }, [finished, run?.exitCode]);

  const recent = run?.startedAt && Date.now() - run.startedAt < 24 * 60 * 60 * 1000;
  const failed = run && !run.running && recent && run.exitCode !== 0 && run.version !== data.current;
  const succeeded = run && !run.running && recent && run.exitCode === 0 && run.version === data.current;

  if (run?.running || (following && !finished)) {
    return (
      <Alert>
        <Loader2Icon className="animate-spin" />
        <AlertTitle>{t("Updating EaglePanel to v{{version}}", { version: run?.version ?? data.latest })}</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>
            {progress.isError
              ? t("The panel is restarting. This page reconnects by itself.")
              : t("It downloads the release, verifies it and runs the installer. The panel restarts at the end.")}
          </span>
          <UpgradeLog lines={run?.log ?? []} />
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      {succeeded && (
        <Alert>
          <CheckCircle2Icon />
          <AlertDescription>{t("Updated to v{{version}}.", { version: run.version })}</AlertDescription>
        </Alert>
      )}
      {failed && (
        <Alert variant="destructive">
          <AlertTitle>
            {run.exitCode === null
              ? t("The update to v{{version}} stopped without finishing", { version: run.version })
              : t("The update to v{{version}} failed", { version: run.version })}
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>{t("The installed panel keeps working. The full output is on the server: journalctl -u eaglepanel-upgrade")}</span>
            <UpgradeLog lines={run.log} />
          </AlertDescription>
        </Alert>
      )}
      {data.updateAvailable && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>{t("EaglePanel {{version}} is available", { version: `v${data.latest}` })}</span>
            {data.releaseUrl && (
              <a href={data.releaseUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary hover:underline">
                {t("View release")}
                <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
              </a>
            )}
          </AlertDescription>
          {data.source === "github" && (
            <AlertAction>
              <Button size="sm" onClick={() => setConfirming(true)}>
                {t("Update now")}
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          setConfirming(next);
          if (!next) start.reset();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Update EaglePanel to v{{version}}", { version: data.latest })}</DialogTitle>
            <DialogDescription>
              {t("The release is downloaded from GitHub, checked against its SHA256 and installed with the saved choices. The panel restarts for a few seconds; the sites keep working.")}
            </DialogDescription>
          </DialogHeader>
          {data.notes && <pre className="max-h-64 overflow-auto rounded-ep border p-3 text-xs whitespace-pre-wrap">{data.notes}</pre>}
          {start.isError && <p className="text-sm text-destructive">{start.error.message}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t("Cancel")}
            </Button>
            <Button disabled={start.isPending} onClick={() => start.mutate(undefined, { onSuccess: () => setConfirming(false) })}>
              {t("Update now")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The panel itself: updated with `eagle upgrade`, from here or on the server. */
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
        {data && <PanelUpgrade data={data} />}
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
