import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ACCOUNT_HOOK_PATH, ORIGIN_PULL_CA_EXPIRES_AT, type AccountDto, type JobCreatedDto, type VhostDto } from "@eaglepanel/shared";
import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { Page } from "@/components/app-shell";
import { ActionFeedback, useJobAction } from "@/components/job-action";
import { LimitFields, limitsFromForm, limitsToForm } from "@/components/limit-fields";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AccountBackups, AccountExportCard } from "@/components/backups";
import { FileManager } from "@/components/file-manager";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { DatabasesTab, FtpTab, ServicesTab } from "@/routes/account-services";
import { PhpSelect, usePhpVersions } from "@/routes/accounts";

const DAY_MS = 86_400_000;
const CERT_WARNING_DAYS = 30;
const ORIGIN_PULL_CA_WARNING_DAYS = 90;

function VhostActions({ vhost, onPhpJob, onDeleteJob }: { vhost: VhostDto; onPhpJob: (version: string) => void; onDeleteJob: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-end gap-2">
      {vhost.app
        ? <Badge variant="outline">{vhost.app.config.kind === "static" ? t("STATIC") : t("APP")} · {vhost.app.config.runtime === "node" ? "Node" : "Bun"} {vhost.app.config.runtimeVersion}</Badge>
        : <PhpSelect value={vhost.phpVersion} onChange={onPhpJob} />}
      {!vhost.isMain && (
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>{t("Delete")}</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("Delete {{name}}?", { name: vhost.fqdn })}</AlertDialogTitle>
              <AlertDialogDescription>{t("The environment is unpublished. Its files remain in the account's home directory.")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onDeleteJob}>{t("Delete")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function DomainSelect({ domains, value, onChange }: { domains: string[]; value: string; onChange: (value: string) => void }) {
  const items = domains.map((domain) => ({ value: domain, label: `.${domain}` }));
  return (
    <Select items={items} value={value} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function VhostsTab({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  const versions = usePhpVersions();
  const [label, setLabel] = useState("");
  const [chosenDomain, setChosenDomain] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const domain = chosenDomain || (account.domains[0] ?? "");
  const php = versions.data?.versions[0] ?? "";
  const extras = account.vhosts.filter(({ isMain }) => !isMain).length;
  const atVhostLimit = extras >= account.limits.vhosts;
  const atDomainLimit = account.domains.length >= account.limits.domains;

  const add = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${account.username}/vhosts`, { fqdn: `${label}.${domain}`, domain, phpVersion: php }));
  const addDomain = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${account.username}/domains`, { domain: newDomain, phpVersion: php }));
  const setPhp = useJobAction(({ fqdn, phpVersion }: { fqdn: string; phpVersion: string }) => api.post<JobCreatedDto>(`/vhosts/${fqdn}/php`, { phpVersion }));
  const remove = useJobAction((fqdn: string) => api.post<JobCreatedDto>(`/vhosts/${fqdn}/delete`));

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    add.mutate();
  }

  function submitDomain(event: SyntheticEvent) {
    event.preventDefault();
    addDomain.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Environments")}</CardTitle>
        <CardDescription>
          {t("{{extras}} of {{vhostLimit}} additional environments · {{domains}} of {{domainLimit}} domains. The primary environment of each domain does not count.", { extras, vhostLimit: account.limits.vhosts, domains: account.domains.length, domainLimit: account.limits.domains })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead>{t("Environment")}</TableHead>
                <TableHead className="hidden @3xl/main:table-cell">{t("Directory")}</TableHead>
                <TableHead>HTTPS</TableHead>
                <TableHead className="text-right">PHP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {account.vhosts.map((vhost) => (
                <TableRow key={vhost.fqdn}>
                  <TableCell>
                    <div className="flex items-center gap-2 font-medium">
                      <Link to="/accounts/$username/environments/$fqdn" params={{ username: account.username, fqdn: vhost.fqdn }} className="hover:underline">{vhost.fqdn}</Link>
                      {vhost.isMain && <Badge variant="secondary">{t("Primary")}</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground @3xl/main:table-cell">{vhost.docRoot}</TableCell>
                  <TableCell>
                    {vhost.certZone ? <Badge variant="outline">{t("Active")}</Badge> : <Badge variant="destructive">{t("No certificate")}</Badge>}
                  </TableCell>
                  <TableCell>
                    <VhostActions
                      vhost={vhost}
                      onPhpJob={(phpVersion) => setPhp.mutate({ fqdn: vhost.fqdn, phpVersion })}
                      onDeleteJob={() => remove.mutate(vhost.fqdn)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <ActionFeedback action={setPhp} />
        <ActionFeedback action={remove} />
        <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <div className="grid gap-2">
              <Label htmlFor="vhost-label">{t("New environment")}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input id="vhost-label" value={label} onChange={(event) => setLabel(event.target.value.toLowerCase().trim())} placeholder="blog" autoComplete="off" spellCheck={false} required className="w-48" />
                {account.domains.length > 1
                  ? <DomainSelect domains={account.domains} value={domain} onChange={setChosenDomain} />
                  : <span className="text-sm text-muted-foreground">.{domain}</span>}
              </div>
            </div>
            <Button type="submit" variant="outline" disabled={add.isPending || !php || atVhostLimit}>{t("Add")}</Button>
          </form>
          <form onSubmit={submitDomain} className="flex flex-wrap items-end gap-2">
            <div className="grid gap-2">
              <Label htmlFor="new-domain">{t("New domain")}</Label>
              <Input id="new-domain" value={newDomain} onChange={(event) => setNewDomain(event.target.value.toLowerCase().trim())} placeholder="another-domain.com" autoComplete="off" spellCheck={false} required disabled={atDomainLimit} className="w-56" />
            </div>
            <Button type="submit" variant="outline" disabled={addDomain.isPending || !php || atDomainLimit}>{t("Add")}</Button>
          </form>
        </div>
        {(atVhostLimit || atDomainLimit) && (
          <p className="text-sm text-muted-foreground">
            {[atVhostLimit && t("The account reached its environment limit."), atDomainLimit && t("The account reached its domain limit.")].filter(Boolean).join(" ")} {t("It can be increased in Settings.")}
          </p>
        )}
        <ActionFeedback action={add} onFinished={(ok) => ok && setLabel("")} />
        <ActionFeedback action={addDomain} onFinished={(ok) => ok && setNewDomain("")} />
      </CardContent>
    </Card>
  );
}

function CertificateCard({ account, zone }: { account: AccountDto; zone: string }) {
  const { t } = useTranslation();
  const [certPem, setCertPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const [editing, setEditing] = useState(false);
  const install = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${account.username}/domains/${zone}/certificate`, { certPem, keyPem }));

  const certificate = account.certificates.find((item) => item.zone === zone);
  const daysLeft = certificate ? Math.floor((certificate.notAfter - Date.now()) / DAY_MS) : 0;
  const uncovered = account.vhosts.filter((vhost) => vhost.domain === zone && !vhost.certZone).map(({ fqdn }) => fqdn);

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    install.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{zone}</CardTitle>
        <CardDescription>{t("Cloudflare requires it in Full (strict) mode to connect over HTTPS. Generate it in SSL/TLS → Origin Server, for the domain and its wildcard.")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {certificate && (
          <dl className="grid gap-2 text-sm sm:grid-cols-[6rem_1fr]">
            <dt className="text-muted-foreground">{t("Covers")}</dt>
            <dd className="font-medium break-all">{certificate.names.join(", ")}</dd>
            <dt className="text-muted-foreground">{t("Expires")}</dt>
            <dd className={daysLeft < CERT_WARNING_DAYS ? "font-medium text-destructive" : "font-medium"}>
              {t("{{date}} ({{days}} days)", { date: formatDateTime(certificate.notAfter), days: daysLeft })}
            </dd>
            {uncovered.length > 0 && (
              <>
                <dt className="text-muted-foreground">{t("Not covered")}</dt>
                <dd className="font-medium break-all text-destructive">{uncovered.join(", ")}</dd>
              </>
            )}
          </dl>
        )}
        {certificate && !editing && (
          <div>
            <Button variant="outline" onClick={() => setEditing(true)}>{t("Replace certificate")}</Button>
          </div>
        )}
        {(!certificate || editing) && (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor={`cert-${zone}`}>{t("Certificate")}</Label>
              <Textarea id={`cert-${zone}`} value={certPem} onChange={(event) => setCertPem(event.target.value)} rows={5} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`key-${zone}`}>{t("Private key")}</Label>
              <Textarea id={`key-${zone}`} value={keyPem} onChange={(event) => setKeyPem(event.target.value)} rows={5} spellCheck={false} autoComplete="off" placeholder="-----BEGIN PRIVATE KEY-----" required />
              <p className="text-sm text-muted-foreground">{t("It is stored only on the server and is not shown again.")}</p>
            </div>
            <div>
              <Button type="submit" disabled={install.isPending}>{t("Install certificate")}</Button>
            </div>
          </form>
        )}
        <ActionFeedback
          action={install}
          onFinished={(ok) => {
            // The key must not stay in browser memory longer than needed.
            setKeyPem("");
            if (ok) {
              setCertPem("");
              setEditing(false);
            }
          }}
        />
        {certificate && <OriginPullSection username={account.username} zone={zone} enabled={certificate.originPull} />}
      </CardContent>
    </Card>
  );
}

function OriginPullSection({ username, zone, enabled }: { username: string; zone: string; enabled: boolean }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const save = useJobAction((next: boolean) => api.post<JobCreatedDto>(`/accounts/${username}/domains/${zone}/origin-pull`, { enabled: next }));
  const daysLeft = Math.floor((ORIGIN_PULL_CA_EXPIRES_AT - Date.now()) / DAY_MS);

  return (
    <div className="flex flex-col gap-4 border-t pt-4">
      <div className="flex items-center justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor={`origin-pull-${zone}`}>{t("Accept connections from Cloudflare only")}</Label>
          <p className="text-sm text-muted-foreground">{t("Authenticated Origin Pulls with the global certificate. It proves the connection comes from Cloudflare, not from your Cloudflare account specifically.")}</p>
        </div>
        <Switch
          id={`origin-pull-${zone}`}
          checked={enabled}
          disabled={save.isPending}
          onCheckedChange={(next) => (next ? setConfirming(true) : save.mutate(false))}
        />
      </div>
      {enabled && daysLeft < ORIGIN_PULL_CA_WARNING_DAYS && (
        <Alert variant="destructive">
          <AlertDescription>{t("The Cloudflare CA used by the panel expires in {{days}} days. Update the panel before that date.", { days: daysLeft })}</AlertDescription>
        </Alert>
      )}
      <ActionFeedback action={save} />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Enable it on {{zone}}?", { zone })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("First turn on the switch in Cloudflare: SSL/TLS → Origin Server → Authenticated Origin Pulls → Global. The panel cannot verify it: if it is off, every environment on this domain stops responding. Applying it restarts OpenLiteSpeed.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirming(false); save.mutate(true); }}>{t("It is on, enable")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CertificatesTab({ account }: { account: AccountDto }) {
  return (
    <div className="flex flex-col gap-4">
      {account.domains.map((zone) => <CertificateCard key={zone} account={account} zone={zone} />)}
    </div>
  );
}

const NO_HOOK_DOMAIN = "__none__";

/** Domain where the account receives the GitHub webhooks for its apps. Works without a certificate too, with Flexible SSL in Cloudflare. */
function HookDomainCard({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(account.hookDomain ?? NO_HOOK_DOMAIN);
  const save = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${account.username}/hook-domain`, { fqdn: value === NO_HOOK_DOMAIN ? null : value }));
  const options = [
    { value: NO_HOOK_DOMAIN, label: t("None") },
    ...account.vhosts.map((vhost) => ({ value: vhost.fqdn, label: vhost.fqdn })),
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("GitHub webhooks")}</CardTitle>
        <CardDescription>
          {t("The account's apps can deploy on every push. Choose one of its environments: the webhook URL is published there, at /_eaglepanel/github; the rest of the site is unchanged. The domain must be proxied by Cloudflare; without a certificate on the server, use Flexible SSL.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-2">
            <Label htmlFor="hook-domain">{t("Domain")}</Label>
            <Select items={options} value={value} onValueChange={(next) => next && setValue(next)}>
              <SelectTrigger id="hook-domain" className="w-72"><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" disabled={save.isPending || value === (account.hookDomain ?? NO_HOOK_DOMAIN)} onClick={() => save.mutate()}>{t("Save")}</Button>
        </div>
        {account.hookDomain && <p className="text-sm text-muted-foreground">URL: <code>https://{account.hookDomain}{ACCOUNT_HOOK_PATH}</code></p>}
        <ActionFeedback action={save} />
      </CardContent>
    </Card>
  );
}

function SettingsTab({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [limits, setLimits] = useState(() => limitsToForm(account.limits));
  const [confirm, setConfirm] = useState("");
  const save = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${account.username}/limits`, limitsFromForm(limits)));
  const remove = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${account.username}/delete`, { confirm }));
  const suspend = useJobAction((suspended: boolean) => api.post<JobCreatedDto>(`/accounts/${account.username}/suspend`, { suspended }));

  function submitLimits(event: SyntheticEvent) {
    event.preventDefault();
    save.mutate();
  }

  function submitDelete(event: SyntheticEvent) {
    event.preventDefault();
    remove.mutate();
  }

  return (
    <div className="flex flex-col gap-4">
      <HookDomainCard account={account} />
      <Card>
        <CardHeader>
          <CardTitle>{t("Limits")}</CardTitle>
          <CardDescription>{t("Databases do not count toward disk usage: they have their own limit.")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitLimits} className="flex flex-col gap-4">
            <LimitFields value={limits} onChange={setLimits} />
            <div>
              <Button type="submit" variant="outline" disabled={save.isPending}>{t("Save limits")}</Button>
            </div>
            <ActionFeedback action={save} />
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{account.suspended ? t("Account suspended") : t("Suspend account")}</CardTitle>
          <CardDescription>{t("Shows a 503 page on all its environments, stops Redis and Memcached, and blocks FTP and MySQL. Nothing is deleted.")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            {account.suspended
              ? <Button variant="outline" disabled={suspend.isPending} onClick={() => suspend.mutate(false)}>{t("Reactivate")}</Button>
              : (
                <AlertDialog>
                  <AlertDialogTrigger render={<Button variant="outline" disabled={suspend.isPending} />}>{t("Suspend")}</AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("Suspend {{name}}?", { name: account.username })}</AlertDialogTitle>
                      <AlertDialogDescription>{t("All its sites stop responding and its open FTP and MySQL connections are closed until you reactivate it. Applying it restarts OpenLiteSpeed.")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => suspend.mutate(true)}>{t("Suspend")}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
          </div>
          <ActionFeedback action={suspend} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("Delete account")}</CardTitle>
          <CardDescription>{t("Deletes the user, its environments, all of its files and its backups. This cannot be undone.")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={submitDelete} className="flex flex-wrap items-end gap-2">
            <div className="grid gap-2">
              <Label htmlFor="confirm">{t("Type {{name}} to confirm", { name: account.username })}</Label>
              <Input id="confirm" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="off" spellCheck={false} className="w-56" />
            </div>
            <Button type="submit" variant="destructive" disabled={confirm !== account.username || remove.isPending}>{t("Delete account")}</Button>
          </form>
          <ActionFeedback action={remove} onFinished={(ok) => ok && void navigate({ to: "/accounts" })} />
        </CardContent>
      </Card>
    </div>
  );
}

/** Account tabs and the URL segment of each one. The first one is the default for /accounts/<user>. */
const ACCOUNT_TABS = [
  { slug: "environments", label: "Environments" },
  { slug: "files", label: "Files" },
  { slug: "databases", label: "Databases" },
  { slug: "backups", label: "Backups" },
  { slug: "ftp", label: "FTP" },
  { slug: "services", label: "Services" },
  { slug: "certificates", label: "Certificates" },
  { slug: "settings", label: "Settings" },
] as const;
type AccountTab = (typeof ACCOUNT_TABS)[number]["slug"];
const isAccountTab = (value: unknown): value is AccountTab => ACCOUNT_TABS.some(({ slug }) => slug === value);

export function AccountDetailPage() {
  const { username, tab: tabParam } = useParams({ strict: false }) as { username: string; tab?: string };
  const { t } = useTranslation();
  const tab: AccountTab = isAccountTab(tabParam) ? tabParam : "environments";
  const navigate = useNavigate();
  const account = useQuery({ queryKey: ["accounts", username], queryFn: () => api.get<AccountDto>(`/accounts/${username}`) });

  return (
    <Page>
      {account.isPending && <Skeleton className="h-48 w-full" />}
      {account.isError && <p className="text-sm text-destructive">{account.error.message}</p>}
      {account.data?.suspended && (
        <Alert variant="destructive">
          <AlertTitle>{t("Account suspended")}</AlertTitle>
          <AlertDescription>{t("Its sites show a 503 page, and FTP and MySQL are blocked. Reactivate it from Settings.")}</AlertDescription>
        </Alert>
      )}
      {account.data && (
        <Tabs
          value={tab}
          onValueChange={(next) => isAccountTab(next) && void navigate({ to: "/accounts/$username/$tab", params: { username, tab: next } })}
          className="gap-4"
        >
          <TabsList>
            {ACCOUNT_TABS.map(({ slug, label }) => <TabsTrigger key={slug} value={slug}>{t(label)}</TabsTrigger>)}
          </TabsList>
          <TabsContent value="environments"><VhostsTab account={account.data} /></TabsContent>
          <TabsContent value="files"><FileManager username={account.data.username} /></TabsContent>
          <TabsContent value="databases"><DatabasesTab account={account.data} /></TabsContent>
          <TabsContent value="backups" className="flex flex-col gap-4"><AccountBackups account={account.data} /><AccountExportCard account={account.data} /></TabsContent>
          <TabsContent value="ftp"><FtpTab account={account.data} /></TabsContent>
          <TabsContent value="services"><ServicesTab account={account.data} /></TabsContent>
          <TabsContent value="certificates"><CertificatesTab account={account.data} /></TabsContent>
          <TabsContent value="settings"><SettingsTab account={account.data} /></TabsContent>
        </Tabs>
      )}
    </Page>
  );
}
