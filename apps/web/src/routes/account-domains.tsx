import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ORIGIN_PULL_CA_EXPIRES_AT, vhostSlugSchema, type AccountDto, type DomainDto, type HostnameMode, type JobCreatedDto, type VhostDto } from "@eaglepanel/shared";
import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { Page } from "@/components/app-shell";
import { ActionFeedback, useJobAction } from "@/components/job-action";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const DAY_MS = 86_400_000;
const CERT_WARNING_DAYS = 30;
const ORIGIN_PULL_CA_WARNING_DAYS = 90;

const route = getRouteApi("/accounts/$username/domains/$zone");

/** Domains and subdomains of the account that no environment uses yet. */
export const freeHostnames = (account: AccountDto) => account.domains.flatMap(({ hostnames }) => hostnames.filter(({ vhost }) => !vhost).map(({ fqdn }) => fqdn));

/** The account domain a name falls under, if any: then it is added as a subdomain of it. */
export const parentDomain = (account: AccountDto, fqdn: string) => account.domains.find((domain) => fqdn.endsWith(`.${domain.fqdn}`))?.fqdn ?? null;

/**
 * A single field for both: under a domain of the account it is a subdomain, otherwise a new domain. A subdomain of a
 * domain the account does not have is rejected by the server.
 */
export function AddHostnameForm({ account, onAdded, autoFocus }: { account: AccountDto; onAdded?: (fqdn: string) => void; autoFocus?: boolean }) {
  const { t } = useTranslation();
  const [fqdn, setFqdn] = useState("");
  const parent = parentDomain(account, fqdn);
  const atDomainLimit = account.domains.length >= account.limits.domains;
  const add = useJobAction((name: string) => (parentDomain(account, name)
    ? api.post<JobCreatedDto>(`/accounts/${account.username}/hostnames`, { fqdn: name })
    : api.post<JobCreatedDto>(`/accounts/${account.username}/domains`, { domain: name })));

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    add.mutate(fqdn);
  }

  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="grid gap-2">
          <Label htmlFor="new-hostname">{t("Domain or subdomain")}</Label>
          <Input id="new-hostname" value={fqdn} onChange={(event) => setFqdn(event.target.value.toLowerCase().trim())} placeholder="example.com" autoComplete="off" spellCheck={false} required autoFocus={autoFocus} className="w-64" />
        </div>
        <Button type="submit" variant="outline" disabled={add.isPending || !fqdn || (!parent && atDomainLimit)}>{parent ? t("Add subdomain") : t("Add domain")}</Button>
      </form>
      <p className="text-sm text-muted-foreground">
        {fqdn.startsWith("www.")
          ? t("Not needed: {{name}} also answers for www.{{name}}.", { name: fqdn.slice(4) })
          : parent
          ? t("Subdomain of {{domain}}.", { domain: parent })
          : atDomainLimit
            ? t("The account reached its domain limit. A subdomain can only be added under one of its domains.")
            : t("{{used}} of {{limit}} domains. Subdomains do not count.", { used: account.domains.length, limit: account.limits.domains })}
      </p>
      <ActionFeedback action={add} onFinished={(ok) => { if (ok) { onAdded?.(fqdn); setFqdn(""); } }} />
    </div>
  );
}

/** On the page of a domain: only subdomains of it, typed without the domain. */
function AddSubdomainForm({ account, domain }: { account: AccountDto; domain: string }) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const fqdn = `${label}.${domain}`;
  const add = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${account.username}/hostnames`, { fqdn }));

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    add.mutate();
  }

  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="grid gap-2">
          <Label htmlFor="new-subdomain">{t("Subdomain")}</Label>
          <div className="flex items-center gap-2">
            <Input id="new-subdomain" value={label} onChange={(event) => setLabel(event.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, ""))} placeholder="shop" autoComplete="off" spellCheck={false} required className="w-40" />
            <span className="text-sm text-muted-foreground">.{domain}</span>
          </div>
        </div>
        <Button type="submit" variant="outline" disabled={add.isPending || !label || label === "www"}>{t("Add subdomain")}</Button>
      </form>
      {label === "www" && <p className="text-sm text-muted-foreground">{t("Not needed: {{name}} also answers for www.{{name}}.", { name: domain })}</p>}
      <ActionFeedback action={add} onFinished={(ok) => { if (ok) setLabel(""); }} />
    </div>
  );
}

export function DomainsTab({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Domains")}</CardTitle>
        <CardDescription>{t("Domains and subdomains of the account. Each one answers once it is assigned to an environment.")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead>{t("Domain")}</TableHead>
                <TableHead>{t("Subdomains")}</TableHead>
                <TableHead>{t("Environments")}</TableHead>
                <TableHead className="text-right">HTTPS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {account.domains.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">{t("The account has no domains yet.")}</TableCell>
                </TableRow>
              )}
              {account.domains.map((domain) => {
                const environments = new Set(domain.hostnames.flatMap(({ vhost }) => (vhost ? [vhost.id] : [])));
                return (
                  <TableRow key={domain.fqdn}>
                    <TableCell className="font-medium">
                      <Link to="/accounts/$username/domains/$zone" params={{ username: account.username, zone: domain.fqdn }} className="hover:underline">{domain.fqdn}</Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{domain.hostnames.length - 1}</TableCell>
                    <TableCell className="text-muted-foreground">{environments.size}</TableCell>
                    <TableCell className="text-right">
                      {domain.certificate ? <Badge variant="outline">{t("Active")}</Badge> : <Badge variant="destructive">{t("No certificate")}</Badge>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <AddHostnameForm account={account} />
      </CardContent>
    </Card>
  );
}

const ADD_NEW = "__new__";

/**
 * Name, slug and domain of an environment. The name only changes in the panel; the slug moves its directory and
 * changes its FTP login; the domain is any free one of the account, of any of its domains.
 */
export function VhostGeneralCard({ account, vhost }: { account: AccountDto; vhost: VhostDto }) {
  const { t } = useTranslation();
  const [name, setName] = useState(vhost.name);
  const [slug, setSlug] = useState(vhost.slug);
  const free = freeHostnames(account);
  const [chosen, setChosen] = useState("");
  const hostname = chosen && (chosen === ADD_NEW || chosen === vhost.hostname || free.includes(chosen)) ? chosen : vhost.hostname;
  const options = [
    { value: vhost.hostname, label: vhost.hostname },
    ...free.map((fqdn) => ({ value: fqdn, label: fqdn })),
    { value: ADD_NEW, label: t("Add a domain or subdomain…") },
  ];
  const rename = useJobAction(() => api.post<JobCreatedDto>(`/vhosts/${vhost.id}/name`, { name, slug }));
  const move = useJobAction(() => api.post<JobCreatedDto>(`/vhosts/${vhost.id}/hostname`, { hostname }));
  const slugChanged = slug !== vhost.slug;
  const slugValid = vhostSlugSchema.safeParse(slug).success;

  function submitName(event: SyntheticEvent) {
    event.preventDefault();
    rename.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("General")}</CardTitle>
        <CardDescription>{t("The slug names its directory (sites/{{slug}}), its OpenLiteSpeed vhost and its FTP login. Changing it moves the directory and restarts OpenLiteSpeed.", { slug: vhost.slug })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <form onSubmit={submitName} className="flex flex-wrap items-end gap-4">
          <div className="grid gap-2">
            <Label htmlFor="vhost-name">{t("Name")}</Label>
            <Input id="vhost-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={64} className="w-56" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="vhost-slug">{t("Slug")}</Label>
            <Input id="vhost-slug" value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""))} required maxLength={32} spellCheck={false} className="w-40 font-mono" />
          </div>
          <Button type="submit" variant="outline" disabled={rename.isPending || !name.trim() || !slugValid || (name === vhost.name && !slugChanged)}>{t("Save")}</Button>
        </form>
        {slugChanged && <p className="text-sm text-muted-foreground">{t("The FTP login of this environment will be {{login}}.", { login: `${slug}@${account.username}` })}</p>}
        <ActionFeedback action={rename} />
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-2">
            <Label htmlFor="vhost-hostname">{t("Domain")}</Label>
            <Select items={options} value={hostname} onValueChange={(next) => next && setChosen(next)}>
              <SelectTrigger id="vhost-hostname" className="w-72"><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {hostname !== ADD_NEW && <Button variant="outline" disabled={move.isPending || hostname === vhost.hostname} onClick={() => move.mutate()}>{t("Change domain")}</Button>}
        </div>
        {hostname === ADD_NEW && <AddHostnameForm account={account} onAdded={setChosen} />}
        <p className="text-sm text-muted-foreground">{t("It also answers with www in front. Changing the domain restarts OpenLiteSpeed: sites are briefly interrupted.")}</p>
        <ActionFeedback action={move} />
      </CardContent>
    </Card>
  );
}

const MODES: { value: HostnameMode; label: string }[] = [
  { value: "alias", label: "Alias" },
  { value: "redirect", label: "Redirect" },
];

/**
 * Other names of the account for an environment. An alias shows the same site: only of its own domain and covered by
 * its certificate, because the vhost has a single one. A redirect sends a 301 to its domain, from any domain of the account.
 */
export function VhostExtrasCard({ account, vhost }: { account: AccountDto; vhost: VhostDto }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<HostnameMode>("redirect");
  const [chosen, setChosen] = useState("");
  const free = freeHostnames(account);
  const choices = mode === "alias" ? free.filter((fqdn) => fqdn === vhost.domain || fqdn.endsWith(`.${vhost.domain}`)) : free;
  const fqdn = chosen === ADD_NEW || choices.includes(chosen) ? chosen : "";
  const options = [...choices.map((name) => ({ value: name, label: name })), { value: ADD_NEW, label: t("Add a domain or subdomain…") }];
  const add = useJobAction(() => api.post<JobCreatedDto>(`/vhosts/${vhost.id}/extras`, { fqdn, mode }));
  const remove = useJobAction((name: string) => api.post<JobCreatedDto>(`/vhosts/${vhost.id}/extras/${name}/delete`));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Aliases and redirects")}</CardTitle>
        <CardDescription>
          {t("An alias shows this same site: it has to be of {{domain}} and covered by its certificate. A redirect sends visitors to {{hostname}}, keeping the path, from any domain of the account.", { domain: vhost.domain, hostname: vhost.hostname })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {vhost.extras.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead>{t("Name")}</TableHead>
                  <TableHead>{t("Type")}</TableHead>
                  <TableHead>HTTPS</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {vhost.extras.map((extra) => (
                  <TableRow key={extra.fqdn}>
                    <TableCell className="font-medium">{extra.fqdn}</TableCell>
                    <TableCell><Badge variant="outline">{t(extra.mode === "alias" ? "Alias" : "Redirect")}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{extra.secure ? t("Yes") : t("No certificate")}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(extra.fqdn)}>{t("Remove")}</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <ActionFeedback action={remove} />
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-2">
            <Label htmlFor="extra-mode">{t("Type")}</Label>
            <Select items={MODES.map(({ value, label }) => ({ value, label: t(label) }))} value={mode} onValueChange={(next) => next && setMode(next as HostnameMode)}>
              <SelectTrigger id="extra-mode" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {MODES.map(({ value, label }) => <SelectItem key={value} value={value}>{t(label)}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="extra-fqdn">{t("Domain")}</Label>
            <Select items={options} value={fqdn || null} onValueChange={(next) => next && setChosen(next)}>
              <SelectTrigger id="extra-fqdn" className="w-72"><SelectValue placeholder={t("Choose a domain")} /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {fqdn !== ADD_NEW && <Button variant="outline" disabled={add.isPending || !fqdn} onClick={() => add.mutate()}>{t("Add")}</Button>}
        </div>
        {fqdn === ADD_NEW && <AddHostnameForm account={account} onAdded={setChosen} />}
        <p className="text-sm text-muted-foreground">{t("Adding or removing one restarts OpenLiteSpeed: sites are briefly interrupted.")}</p>
        <ActionFeedback action={add} onFinished={(ok) => { if (ok) setChosen(""); }} />
      </CardContent>
    </Card>
  );
}

function HostnamesCard({ account, domain }: { account: AccountDto; domain: DomainDto }) {
  const { t } = useTranslation();
  const remove = useJobAction((fqdn: string) => api.post<JobCreatedDto>(`/hostnames/${fqdn}/delete`));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Domain and subdomains")}</CardTitle>
        <CardDescription>{t("Which environment answers for each one. They are assigned from the environment.")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead>{t("Name")}</TableHead>
                <TableHead>{t("Environment")}</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {domain.hostnames.map(({ fqdn, vhost }) => (
                <TableRow key={fqdn}>
                  <TableCell className="font-medium">{fqdn}</TableCell>
                  <TableCell>
                    {vhost
                      ? (
                        <span className="flex items-center gap-2">
                          <Link to="/accounts/$username/environments/$slug" params={{ username: account.username, slug: vhost.slug }} className="hover:underline">{vhost.name}</Link>
                          {vhost.mode !== "main" && <Badge variant="outline">{t(vhost.mode === "alias" ? "Alias" : "Redirect")}</Badge>}
                        </span>
                      )
                      : <span className="text-muted-foreground">{t("Unassigned")}</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {fqdn !== domain.fqdn && !vhost && <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(fqdn)}>{t("Delete")}</Button>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <ActionFeedback action={remove} />
        <AddSubdomainForm account={account} domain={domain.fqdn} />
      </CardContent>
    </Card>
  );
}

function CertificateCard({ account, domain }: { account: AccountDto; domain: DomainDto }) {
  const { t } = useTranslation();
  const zone = domain.fqdn;
  const [certPem, setCertPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const [editing, setEditing] = useState(false);
  const install = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${account.username}/domains/${zone}/certificate`, { certPem, keyPem }));

  const certificate = domain.certificate;
  const daysLeft = certificate ? Math.floor((certificate.notAfter - Date.now()) / DAY_MS) : 0;
  const uncovered = account.vhosts.filter((vhost) => vhost.domain === zone && !vhost.certZone).map(({ hostname }) => hostname);

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    install.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Certificate")}</CardTitle>
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
              <Label htmlFor="cert-pem">{t("Certificate")}</Label>
              <Textarea id="cert-pem" value={certPem} onChange={(event) => setCertPem(event.target.value)} rows={5} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="key-pem">{t("Private key")}</Label>
              <Textarea id="key-pem" value={keyPem} onChange={(event) => setKeyPem(event.target.value)} rows={5} spellCheck={false} autoComplete="off" placeholder="-----BEGIN PRIVATE KEY-----" required />
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

function DeleteDomainCard({ account, domain }: { account: AccountDto; domain: DomainDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const remove = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${account.username}/domains/${domain.fqdn}/delete`));
  const environments = account.vhosts.filter((vhost) => vhost.domain === domain.fqdn).map(({ name }) => name);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Delete domain")}</CardTitle>
        <CardDescription>
          {environments.length > 0
            ? t("Its environments have to be deleted or moved to another domain first: {{names}}.", { names: environments.join(", ") })
            : t("Deletes the domain, its subdomains and its certificate. No files are deleted.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive" disabled={remove.isPending || environments.length > 0} />}>{t("Delete domain")}</AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("Delete {{name}}?", { name: domain.fqdn })}</AlertDialogTitle>
                <AlertDialogDescription>{t("Deletes the domain, its subdomains and its certificate. No files are deleted.")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>{t("Delete")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <ActionFeedback action={remove} onFinished={(ok) => ok && void navigate({ to: "/accounts/$username/$tab", params: { username: account.username, tab: "domains" } })} />
      </CardContent>
    </Card>
  );
}

export function DomainDetailPage() {
  const { t } = useTranslation();
  const { username, zone } = route.useParams();
  const account = useQuery({ queryKey: ["accounts", username], queryFn: () => api.get<AccountDto>(`/accounts/${username}`) });
  const domain = account.data?.domains.find((item) => item.fqdn === zone);

  return (
    <Page>
      <div>
        <Button variant="link" className="h-auto p-0" nativeButton={false} render={<Link to="/accounts/$username/$tab" params={{ username, tab: "domains" }} />}>← {username}</Button>
        <h2 className="mt-1 text-lg font-medium">{zone}</h2>
      </div>
      {account.isPending && <Skeleton className="h-48 w-full" />}
      {account.isError && <p className="text-sm text-destructive">{account.error.message}</p>}
      {account.data && !domain && <p className="text-sm text-muted-foreground">{t("The domain does not exist.")}</p>}
      {account.data && domain && (
        <div className="flex flex-col gap-4">
          <HostnamesCard account={account.data} domain={domain} />
          <CertificateCard account={account.data} domain={domain} />
          <DeleteDomainCard account={account.data} domain={domain} />
        </div>
      )}
    </Page>
  );
}
