import { Link } from "@tanstack/react-router";
import type { VulnerabilityDto, VulnerabilitySeverity, WordPressInstallDto, WpCoreStatus, WpExtensionDto } from "@eaglepanel/shared";
import { ArrowUpRightIcon, ChevronDownIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { Page } from "@/components/app-shell";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { serverText } from "@/lib/i18n";
import { installVulnerabilities, needsAttention, useCheckWordPress, useWordPressStatus } from "@/lib/wordpress";
import { SeverityBadge } from "@/routes/updates";

const SEVERITY_ORDER: VulnerabilitySeverity[] = ["critical", "high", "medium", "low", "negligible", "unknown"];
const worst = (vulns: VulnerabilityDto[]) => [...vulns].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))[0];

function CoreBadge({ status, latest }: { status: WpCoreStatus; latest: string | null }) {
  const { t } = useTranslation();
  if (status === "latest") return <Badge variant="success">{t("Up to date")}</Badge>;
  if (status === "insecure") return <Badge variant="destructive">{t("Insecure release")}</Badge>;
  if (status === "outdated") return <Badge variant="warning">{latest ? t("Update to {{version}}", { version: latest }) : t("Outdated")}</Badge>;
  return <Badge variant="outline">{t("Unknown")}</Badge>;
}

function ExtensionStatus({ ext }: { ext: WpExtensionDto }) {
  const { t } = useTranslation();
  if (ext.status === "up-to-date") return <Badge variant="success">{t("Up to date")}</Badge>;
  if (ext.status === "outdated") return <Badge variant="warning">{t("Outdated")}</Badge>;
  if (ext.status === "closed") {
    return (
      <Badge variant="destructive" title={ext.closedReason ? serverText(ext.closedReason) : undefined}>
        {t("Closed on WordPress.org")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" title={t("Not on WordPress.org: premium, custom or removed. Its updates cannot be checked.")}>
      {t("Not on WordPress.org")}
    </Badge>
  );
}

function VulnerabilityList({ vulns }: { vulns: VulnerabilityDto[] }) {
  const { t } = useTranslation();
  if (!vulns.length) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <ul className="flex flex-col gap-1.5">
      {vulns.map((v) => (
        <li key={v.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <SeverityBadge severity={v.severity} />
          <a href={v.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-primary hover:underline">
            {v.id}
            <ArrowUpRightIcon className="size-3" aria-hidden="true" />
          </a>
          <span className="text-muted-foreground">{v.fixedIn ? t("Fixed in {{version}}", { version: v.fixedIn }) : t("No fix published")}</span>
          {v.summary && <span className="basis-full text-muted-foreground">{v.summary}</span>}
        </li>
      ))}
    </ul>
  );
}

function ExtensionsTable({ title, items }: { title: string; items: WpExtensionDto[] }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">
        {title} <span className="text-muted-foreground">({items.length})</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("None installed.")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead>{t("Name")}</TableHead>
                <TableHead>{t("Installed")}</TableHead>
                <TableHead>{t("Latest")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
                <TableHead>{t("Vulnerabilities")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((ext) => (
                <TableRow key={ext.slug}>
                  <TableCell className="align-top">
                    <span className="block font-medium">{ext.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{ext.slug}</span>
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs">{ext.version || "—"}</TableCell>
                  <TableCell className="align-top font-mono text-xs">{ext.latest ?? "—"}</TableCell>
                  <TableCell className="align-top"><ExtensionStatus ext={ext} /></TableCell>
                  <TableCell className="max-w-xl align-top whitespace-normal"><VulnerabilityList vulns={ext.vulnerabilities} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function InstallDetails({ install }: { install: WordPressInstallDto }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="font-mono text-xs text-muted-foreground">~/{install.path}</p>
      {install.coreVulnerabilities.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t("WordPress {{version}}", { version: install.version })}</h3>
          <VulnerabilityList vulns={install.coreVulnerabilities} />
        </section>
      )}
      <ExtensionsTable title={t("Plugins")} items={install.plugins} />
      <ExtensionsTable title={t("Themes")} items={install.themes} />
    </div>
  );
}

function ExtensionSummary({ items }: { items: WpExtensionDto[] }) {
  const { t } = useTranslation();
  const outdated = items.filter((e) => e.status === "outdated").length;
  const closed = items.filter((e) => e.status === "closed").length;
  return (
    <span className="flex flex-col gap-0.5 text-xs">
      <span>{t("{{count}} installed", { count: items.length })}</span>
      {outdated > 0 && <span className="text-warning">{t("{{count}} outdated", { count: outdated })}</span>}
      {closed > 0 && <span className="text-destructive">{t("{{count}} closed", { count: closed })}</span>}
    </span>
  );
}

function InstallRow({ install, tracked }: { install: WordPressInstallDto; tracked: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const vulns = installVulnerabilities(install);
  const top = worst(vulns);
  return (
    <Fragment>
      <TableRow>
        <TableCell className="align-top">
          <Link to="/accounts/$username/environments/$slug" params={{ username: install.username, slug: install.vhostSlug }} className="font-medium hover:underline">
            {install.vhostName}
          </Link>
          <span className="block font-mono text-xs text-muted-foreground">
            {install.hostname}
            {install.urlPath === "/" ? "" : install.urlPath}
          </span>
          <span className="block text-xs text-muted-foreground">{install.username}</span>
        </TableCell>
        <TableCell className="align-top">
          <span className="flex flex-col items-start gap-1">
            <span className="font-mono text-xs">{install.version}</span>
            <CoreBadge status={install.coreStatus} latest={install.latest} />
            {install.multisite && <Badge variant="outline">Multisite</Badge>}
          </span>
        </TableCell>
        <TableCell className="align-top"><ExtensionSummary items={install.plugins} /></TableCell>
        <TableCell className="align-top"><ExtensionSummary items={install.themes} /></TableCell>
        <TableCell className="align-top">
          {!tracked ? (
            <span className="text-xs text-muted-foreground">{t("Not checked")}</span>
          ) : top ? (
            <span className="inline-flex items-center gap-2 text-xs">
              <SeverityBadge severity={top.severity} />
              {vulns.length}
            </span>
          ) : (
            <Badge variant="success">{t("None known")}</Badge>
          )}
        </TableCell>
        <TableCell className="text-right align-top">
          <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
            {t("Details")}
          </Button>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="whitespace-normal">
            <InstallDetails install={install} />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

function Attribution() {
  const { t } = useTranslation();
  return (
    <p className="text-xs text-muted-foreground">
      {t("Vulnerability data:")}{" "}
      <a href="https://www.wordfence.com/threat-intel/" target="_blank" rel="noreferrer noopener" className="hover:underline">Wordfence Intelligence</a>, Copyright 2012-2026 Defiant Inc. (
      <a href="https://www.wordfence.com/wordfence-intelligence-terms-and-conditions/" target="_blank" rel="noreferrer noopener" className="hover:underline">{t("license")}</a>
      ). CVE® Copyright 1999-2026 The MITRE Corporation (
      <a href="https://www.cve.org/Legal/TermsOfUse" target="_blank" rel="noreferrer noopener" className="hover:underline">{t("terms of use")}</a>
      ).
    </p>
  );
}

export function WordPressPage() {
  const { t } = useTranslation();
  const status = useWordPressStatus();
  const check = useCheckWordPress();
  const data = status.data;
  const busy = check.isPending || data?.checking;
  const tracked = Boolean(data?.vulnerabilities.configured && data.vulnerabilities.updatedAt);
  const attention = data?.installs.filter(needsAttention).length ?? 0;

  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>WordPress</CardTitle>
          <CardDescription>
            {t("Installations found in the environments, with the versions of core, plugins and themes compared with WordPress.org.")}{" "}
            {data?.checkedAt
              ? t("Checked every hour. Last checked {{date}}.", { date: formatDateTime(data.checkedAt) })
              : t("Checked every hour. The first check runs shortly after the panel starts.")}
          </CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => check.mutate()}>
              <RefreshCwIcon className={busy ? "animate-spin" : undefined} />
              {busy ? t("Checking…") : t("Check now")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {data && !data.vulnerabilities.configured && (
            <Alert>
              <AlertDescription>{t("Vulnerabilities are not checked yet: they need a free Wordfence Intelligence API key.")}</AlertDescription>
              <AlertAction>
                <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/settings" />}>
                  {t("Add API key")}
                </Button>
              </AlertAction>
            </Alert>
          )}
          {data?.error && (
            <Alert variant="destructive">
              <AlertDescription>{serverText(data.error)}</AlertDescription>
            </Alert>
          )}
          {data?.versionsError && (
            <Alert variant="destructive">
              <AlertDescription>{t("WordPress.org did not answer: {{error}}", { error: serverText(data.versionsError) })}</AlertDescription>
            </Alert>
          )}
          {data?.vulnerabilities.error && (
            <Alert variant="destructive">
              <AlertDescription>{t("The Wordfence feed could not be downloaded: {{error}}", { error: serverText(data.vulnerabilities.error) })}</AlertDescription>
            </Alert>
          )}
          {status.isPending && <Skeleton className="h-40 w-full" />}
          {status.isError && <p className="text-sm text-destructive">{status.error.message}</p>}
          {data && data.installs.length === 0 && !data.checking && (
            <p className="text-sm text-muted-foreground">{data.checkedAt ? t("No WordPress installations were found.") : t("No check has finished yet.")}</p>
          )}
          {data && data.installs.length > 0 && (
            <>
              <p className="text-sm text-muted-foreground">
                {t("{{count}} installations", { count: data.installs.length })}
                {data.latestCore && ` · ${t("Latest WordPress: {{version}}", { version: data.latestCore })}`}
                {attention > 0 && ` · ${t("{{count}} need attention", { count: attention })}`}
              </p>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader className="bg-muted">
                    <TableRow>
                      <TableHead>{t("Site")}</TableHead>
                      <TableHead>WordPress</TableHead>
                      <TableHead>{t("Plugins")}</TableHead>
                      <TableHead>{t("Themes")}</TableHead>
                      <TableHead>{t("Vulnerabilities")}</TableHead>
                      <TableHead className="text-right">
                        <span className="sr-only">{t("Details")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.installs.map((install) => (
                      <InstallRow key={install.id} install={install} tracked={tracked} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
          {tracked && data?.vulnerabilities.updatedAt && (
            <p className="text-xs text-muted-foreground">
              {t("Vulnerability database downloaded {{date}} ({{count}} records). It is downloaded again once a day.", {
                date: formatDateTime(data.vulnerabilities.updatedAt),
                count: data.vulnerabilities.records,
              })}
            </p>
          )}
          {tracked && <Attribution />}
        </CardContent>
      </Card>
    </Page>
  );
}
