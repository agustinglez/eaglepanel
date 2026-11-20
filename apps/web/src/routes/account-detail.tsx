import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ACCOUNT_HOOK_PATH, slugify, vhostSlugSchema, type AccountDto, type JobCreatedDto, type VhostDto } from "@eaglepanel/shared";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AccountBackups, AccountExportCard } from "@/components/backups";
import { FileManager } from "@/components/file-manager";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { AddHostnameForm, DomainsTab, freeHostnames } from "@/routes/account-domains";
import { DatabasesTab, FtpTab, ServicesTab } from "@/routes/account-services";
import { PhpSelect, usePhpVersions } from "@/routes/accounts";

const NEW_HOSTNAME = "__new__";

function VhostActions({ vhost, onPhpJob, onDeleteJob }: { vhost: VhostDto; onPhpJob: (version: string) => void; onDeleteJob: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-end gap-2">
      {vhost.app
        ? <Badge variant="outline">{vhost.app.config.kind === "static" ? t("STATIC") : t("APP")} · {vhost.app.config.runtime === "node" ? "Node" : "Bun"} {vhost.app.config.runtimeVersion}</Badge>
        : <PhpSelect value={vhost.phpVersion} onChange={onPhpJob} />}
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>{t("Delete")}</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete {{name}}?", { name: vhost.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("The environment is unpublished and its domain is left unassigned. Its files remain in the account's home directory.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDeleteJob}>{t("Delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Name, slug (from the name until it is edited), domain and PHP: the slug names its directory, vhost and FTP login. */
function NewVhostForm({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  const versions = usePhpVersions();
  const free = freeHostnames(account);
  const [name, setName] = useState("");
  const [customSlug, setCustomSlug] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");
  const slug = customSlug ?? slugify(name);
  const hostname = chosen && (chosen === NEW_HOSTNAME || free.includes(chosen)) ? chosen : (free[0] ?? NEW_HOSTNAME);
  const php = versions.data?.versions[0] ?? "";
  const atVhostLimit = account.vhosts.length >= account.limits.vhosts;
  const slugValid = vhostSlugSchema.safeParse(slug).success;
  const options = [...free.map((fqdn) => ({ value: fqdn, label: fqdn })), { value: NEW_HOSTNAME, label: t("Add a domain or subdomain…") }];
  const add = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${account.username}/vhosts`, { name, slug, hostname, phpVersion: php }));

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    add.mutate();
  }

  return (
    <div className="flex flex-col gap-4 border-t pt-4">
      <h3 className="text-sm font-medium">{t("New environment")}</h3>
      <form onSubmit={submit} className="flex flex-wrap items-start gap-4">
        <div className="grid gap-2">
          <Label htmlFor="vhost-name">{t("Name")}</Label>
          <Input id="vhost-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("My site")} autoComplete="off" required maxLength={64} className="w-56" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="vhost-slug">{t("Slug")}</Label>
          <Input id="vhost-slug" value={slug} onChange={(event) => setCustomSlug(event.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""))} placeholder="mysite" autoComplete="off" spellCheck={false} required maxLength={32} className="w-40 font-mono" />
          <p className="max-w-56 text-xs text-muted-foreground">{t("Letters and digits, unique on the server: sites/{{slug}}", { slug: slug || "…" })}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="vhost-hostname">{t("Domain")}</Label>
          <Select items={options} value={hostname} onValueChange={(next) => next && setChosen(next)}>
            <SelectTrigger id="vhost-hostname" className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        {hostname !== NEW_HOSTNAME && (
          <div className="grid gap-2">
            <Label className="invisible">{t("Create environment")}</Label>
            <Button type="submit" variant="outline" disabled={add.isPending || !php || !name.trim() || !slugValid || atVhostLimit}>{t("Create environment")}</Button>
          </div>
        )}
      </form>
      {hostname === NEW_HOSTNAME && <AddHostnameForm account={account} onAdded={setChosen} />}
      {atVhostLimit && <p className="text-sm text-muted-foreground">{t("The account reached its environment limit.")} {t("It can be increased in Settings.")}</p>}
      <ActionFeedback action={add} onFinished={(ok) => { if (ok) { setName(""); setCustomSlug(null); setChosen(""); } }} />
    </div>
  );
}

function VhostsTab({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  const setPhp = useJobAction(({ id, phpVersion }: { id: number; phpVersion: string }) => api.post<JobCreatedDto>(`/vhosts/${id}/php`, { phpVersion }));
  const remove = useJobAction((id: number) => api.post<JobCreatedDto>(`/vhosts/${id}/delete`));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Environments")}</CardTitle>
        <CardDescription>
          {t("{{used}} of {{limit}} environments. Each one answers for one domain or subdomain, which can be changed.", { used: account.vhosts.length, limit: account.limits.vhosts })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead>{t("Environment")}</TableHead>
                <TableHead className="hidden @3xl/main:table-cell">Slug</TableHead>
                <TableHead>HTTPS</TableHead>
                <TableHead className="text-right">PHP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {account.vhosts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">{t("The account has no environments yet.")}</TableCell>
                </TableRow>
              )}
              {account.vhosts.map((vhost) => (
                <TableRow key={vhost.id}>
                  <TableCell>
                    <Link to="/accounts/$username/environments/$slug" params={{ username: account.username, slug: vhost.slug }} className="font-medium hover:underline">{vhost.name}</Link>
                    <span className="ml-2 text-muted-foreground">({vhost.hostname})</span>
                  </TableCell>
                  <TableCell className="hidden font-mono text-muted-foreground @3xl/main:table-cell">{vhost.slug}</TableCell>
                  <TableCell>
                    {vhost.certZone ? <Badge variant="outline">{t("Active")}</Badge> : <Badge variant="destructive">{t("No certificate")}</Badge>}
                  </TableCell>
                  <TableCell>
                    <VhostActions
                      vhost={vhost}
                      onPhpJob={(phpVersion) => setPhp.mutate({ id: vhost.id, phpVersion })}
                      onDeleteJob={() => remove.mutate(vhost.id)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <ActionFeedback action={setPhp} />
        <ActionFeedback action={remove} />
        <NewVhostForm account={account} />
      </CardContent>
    </Card>
  );
}

const NO_HOOK_DOMAIN = "__none__";

/** Domain where the account receives the GitHub webhooks for its apps. Works without a certificate too, with Flexible SSL in Cloudflare. */
function HookDomainCard({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  const current = account.hookVhost === null ? NO_HOOK_DOMAIN : String(account.hookVhost);
  const [value, setValue] = useState(current);
  const save = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${account.username}/hook-vhost`, { vhost: value === NO_HOOK_DOMAIN ? null : Number(value) }));
  const options = [
    { value: NO_HOOK_DOMAIN, label: t("None") },
    ...account.vhosts.map((vhost) => ({ value: String(vhost.id), label: `${vhost.name} (${vhost.hostname})` })),
  ];
  const hookHostname = account.vhosts.find((vhost) => vhost.id === account.hookVhost)?.hostname;
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
            <Label htmlFor="hook-domain">{t("Environment")}</Label>
            <Select items={options} value={value} onValueChange={(next) => next && setValue(next)}>
              <SelectTrigger id="hook-domain" className="w-72"><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" disabled={save.isPending || value === current} onClick={() => save.mutate()}>{t("Save")}</Button>
        </div>
        {hookHostname && <p className="text-sm text-muted-foreground">URL: <code>https://{hookHostname}{ACCOUNT_HOOK_PATH}</code></p>}
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
  { slug: "domains", label: "Domains" },
  { slug: "environments", label: "Environments" },
  { slug: "files", label: "Files" },
  { slug: "databases", label: "Databases" },
  { slug: "backups", label: "Backups" },
  { slug: "ftp", label: "FTP" },
  { slug: "services", label: "Services" },
  { slug: "settings", label: "Settings" },
] as const;
type AccountTab = (typeof ACCOUNT_TABS)[number]["slug"];
const isAccountTab = (value: unknown): value is AccountTab => ACCOUNT_TABS.some(({ slug }) => slug === value);

export function AccountDetailPage() {
  const { username, tab: tabParam } = useParams({ strict: false }) as { username: string; tab?: string };
  const { t } = useTranslation();
  const tab: AccountTab = isAccountTab(tabParam) ? tabParam : "domains";
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
          <TabsContent value="domains"><DomainsTab account={account.data} /></TabsContent>
          <TabsContent value="environments"><VhostsTab account={account.data} /></TabsContent>
          <TabsContent value="files"><FileManager username={account.data.username} /></TabsContent>
          <TabsContent value="databases"><DatabasesTab account={account.data} /></TabsContent>
          <TabsContent value="backups" className="flex flex-col gap-4"><AccountBackups account={account.data} /><AccountExportCard account={account.data} /></TabsContent>
          <TabsContent value="ftp"><FtpTab account={account.data} /></TabsContent>
          <TabsContent value="services"><ServicesTab account={account.data} /></TabsContent>
          <TabsContent value="settings"><SettingsTab account={account.data} /></TabsContent>
        </Tabs>
      )}
    </Page>
  );
}
