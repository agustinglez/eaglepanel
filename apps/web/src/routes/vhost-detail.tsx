import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { siteDir, type AccountDto, type JobCreatedDto, type LogLevel, type LogSource, type PhpOptions, type VhostDto } from "@eaglepanel/shared";
import { LockIcon } from "lucide-react";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Page } from "@/components/app-shell";
import { ActionFeedback, useJobAction } from "@/components/job-action";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { VhostGeneralCard } from "@/routes/account-domains";
import { SiteFtpCard } from "@/routes/account-services";
import { PhpSelect } from "@/routes/accounts";
import { AppConfigForm, AppPanel } from "@/routes/app-panel";

const route = getRouteApi("/accounts/$username/environments/$id");

const VHOST_TABS = ["options", "logs", "ftp", "app"] as const;
type VhostTab = (typeof VHOST_TABS)[number];
const isVhostTab = (value: unknown): value is VhostTab => VHOST_TABS.includes(value as VhostTab);

/** `?tab=ftp` opens that tab: the account FTP list links straight to it. */
export const validateVhostSearch = (search: Record<string, unknown>): { tab?: VhostTab } => (isVhostTab(search.tab) ? { tab: search.tab } : {});

const DIRECTIVES: { key: Exclude<keyof PhpOptions["directives"], "error_reporting">; label: string }[] = [
  { key: "memory_limit", label: "memory_limit" },
  { key: "upload_max_filesize", label: "upload_max_filesize" },
  { key: "post_max_size", label: "post_max_size" },
  { key: "max_execution_time", label: "max_execution_time (seconds)" },
  { key: "max_input_time", label: "max_input_time (seconds)" },
  { key: "max_input_vars", label: "max_input_vars" },
  { key: "session.gc_maxlifetime", label: "session.gc_maxlifetime (seconds)" },
  { key: "date.timezone", label: "date.timezone" },
];
const ERROR_LEVELS: PhpOptions["directives"]["error_reporting"][] = ["E_ALL", "E_ALL & ~E_DEPRECATED", "E_ERROR"];
const FLAGS: (keyof PhpOptions["flags"])[] = ["short_open_tag", "display_errors", "log_errors", "zlib.output_compression"];

const lockedFor = (username: string) => [
  ["open_basedir", `/home/${username}`],
  ["upload_tmp_dir", `/home/${username}/tmp`],
  ["session.save_path", `/home/${username}/tmp`],
  ["disable_functions", "exec, passthru, shell_exec, system, proc_open, popen, pcntl_exec"],
  ["allow_url_include", "off"],
] as const;

const LOG_LEVELS: LogLevel[] = ["ERROR", "WARN", "NOTICE", "INFO", "DEBUG"];
const LOG_SOURCES: { value: LogSource; label: string; empty: string }[] = [
  { value: "access", label: "Access", empty: "No requests logged yet." },
  { value: "php", label: "PHP errors", empty: "No PHP errors in logs/. If the account changed error_log, they are wherever it points to." },
  { value: "error", label: "Server errors", empty: "No server errors yet." },
];
const LOG_REFRESH_MS = 3000;
const LOG_LINES = 200;

function LogsPanel({ vhost }: { vhost: VhostDto }) {
  const { t } = useTranslation();
  const [source, setSource] = useState<LogSource>("access");
  const [live, setLive] = useState(true);
  const logs = useQuery({
    queryKey: ["logs", vhost.id, source],
    queryFn: () => api.get<{ lines: string[] }>(`/vhosts/${vhost.id}/logs?source=${source}&lines=${LOG_LINES}`),
    // On failure, stop polling every 3 seconds with the same error.
    refetchInterval: (query) => (live && !query.state.error ? LOG_REFRESH_MS : false),
  });
  const output = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  const lines = logs.data?.lines;

  // Follow new lines, unless the user scrolled up to read.
  useEffect(() => {
    const element = output.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  const current = LOG_SOURCES.find((item) => item.value === source);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Logs</CardTitle>
        <CardDescription>{t("Last {{lines}} lines for {{fqdn}}, exactly as logged.", { lines: LOG_LINES, fqdn: vhost.name })}</CardDescription>
        <CardAction className="flex items-center gap-2">
          <Label htmlFor="live" className="font-normal">{t("Live")}</Label>
          <Switch id="live" checked={live} onCheckedChange={setLive} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Select items={LOG_SOURCES.map(({ value, label }) => ({ value, label: t(label) }))} value={source} onValueChange={(next) => next && setSource(next)}>
          <SelectTrigger aria-label="Log" className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {LOG_SOURCES.map(({ value, label }) => <SelectItem key={value} value={value}>{t(label)}</SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>
        {logs.isError && (
          <Alert variant="destructive">
            <AlertDescription>{logs.error.message}</AlertDescription>
          </Alert>
        )}
        {logs.isPending && <Skeleton className="h-80 w-full" />}
        {lines && (
          <pre
            ref={output}
            onScroll={(event) => {
              const element = event.currentTarget;
              atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
            }}
            className="h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs"
          >
            {lines.length > 0 ? lines.join("\n") : current && t(current.empty)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function toMb(value: string): number {
  const match = /^(\d+)([KMG]?)$/.exec(value.trim());
  if (!match) return Number.NaN;
  const factor = { "": 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 }[match[2] as "" | "K" | "M" | "G"];
  return Number(match[1]) * factor;
}

function warningsFor({ memoryMb, directives, flags }: PhpOptions, t: TFunction): string[] {
  const warnings: string[] = [];
  if (toMb(directives.memory_limit) > memoryMb) warnings.push(t("memory_limit exceeds the process memory ({{memory}} MB): PHP would be stopped before reaching that value.", { memory: memoryMb }));
  if (toMb(directives.upload_max_filesize) > toMb(directives.post_max_size)) warnings.push(t("upload_max_filesize exceeds post_max_size: large uploads would fail anyway."));
  if (flags.display_errors) warnings.push(t("display_errors is on: visitors would see internal paths and data when an error occurs."));
  return warnings;
}

function SwitchRow({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="grid gap-1">
        <Label htmlFor={id}>{label}</Label>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function VhostForm({ username, vhost }: { username: string; vhost: VhostDto }) {
  const { t } = useTranslation();
  const [docRoot, setDocRoot] = useState(vhost.docRoot);
  const [phpVersion, setPhpVersion] = useState(vhost.phpVersion);
  const [options, setOptions] = useState(vhost.phpOptions);
  const [logLevel, setLogLevel] = useState(vhost.logLevel);
  const [logDays, setLogDays] = useState(vhost.logDays);
  const save = useJobAction(() => api.post<JobCreatedDto>(`/vhosts/${vhost.id}/options`, { docRoot, phpVersion, phpOptions: options, logLevel, logDays }));
  const restart = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${username}/php/restart`));
  const warnings = warningsFor(options, t);
  const setDirective = (key: keyof PhpOptions["directives"], value: string) =>
    setOptions({ ...options, directives: { ...options.directives, [key]: value } });

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>{t("Code is uploaded over FTP to the public directory.")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="docroot">{t("Public directory")}</Label>
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-sm text-muted-foreground">/home/{username}/</span>
              <Input id="docroot" value={docRoot} onChange={(event) => setDocRoot(event.target.value.replace(/^\/+/, ""))} spellCheck={false} required />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="index">{t("Index files")}</Label>
            <Input id="index" value={options.indexFiles} onChange={(event) => setOptions({ ...options, indexFiles: event.target.value })} spellCheck={false} required />
          </div>
          <SwitchRow id="gzip" label={t("Gzip compression")} checked={options.gzip} onChange={(gzip) => setOptions({ ...options, gzip })} />
          <SwitchRow id="htaccess" label={t("Read .htaccess")} hint={t("Rewrite rules and per-directory configuration.")} checked={options.htaccess} onChange={(htaccess) => setOptions({ ...options, htaccess })} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Version and resources")}</CardTitle>
          <CardDescription>{t("Each environment runs its own PHP process, always as the account user.")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="grid content-start gap-2">
            <Label htmlFor="php-version">{t("Version")}</Label>
            <PhpSelect id="php-version" value={phpVersion} onChange={setPhpVersion} />
          </div>
          <div className="grid content-start gap-2">
            <Label htmlFor="php-children">{t("Processes")}</Label>
            <Input id="php-children" type="number" min="1" max="50" value={options.children} onChange={(event) => setOptions({ ...options, children: Number(event.target.value) })} />
          </div>
          <div className="grid content-start gap-2">
            <Label htmlFor="php-memory">{t("Process memory (MB)")}</Label>
            <Input id="php-memory" type="number" min="64" max="8192" step="64" value={options.memoryMb} onChange={(event) => setOptions({ ...options, memoryMb: Number(event.target.value) })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Directives")}</CardTitle>
          <CardDescription>{t("Default values for the environment. The .user.ini file in its public directory belongs to the account, overrides them and takes effect within seconds. If that file is deleted, restart PHP.")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {DIRECTIVES.map(({ key, label }) => (
              <div key={key} className="grid content-start gap-2">
                <Label htmlFor={key}>{t(label)}</Label>
                <Input id={key} className="font-mono" value={options.directives[key]} onChange={(event) => setDirective(key, event.target.value)} spellCheck={false} required />
              </div>
            ))}
            <div className="grid content-start gap-2">
              <Label htmlFor="error_reporting">error_reporting</Label>
              <Select items={ERROR_LEVELS.map((value) => ({ value, label: value }))} value={options.directives.error_reporting} onValueChange={(next) => next && setDirective("error_reporting", next)}>
                <SelectTrigger id="error_reporting" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {ERROR_LEVELS.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {FLAGS.map((flag) => (
              <SwitchRow key={flag} id={flag} label={flag} checked={options.flags[flag]} onChange={(checked) => setOptions({ ...options, flags: { ...options.flags, [flag]: checked } })} />
            ))}
          </div>
          {warnings.length > 0 && (
            <Alert>
              <AlertTitle>{t("Review these values")}</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logs</CardTitle>
          <CardDescription>{t("Access and server error logs rotate daily. The PHP error_log belongs to the account: it is in {{dir}}, it is packed into a tar.gz there when it reaches 20 MB or every month, counts toward its quota, and the panel does not delete those files.", { dir: `${siteDir(vhost.slug)}/logs` })}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4">
          <div className="grid gap-2">
            <Label htmlFor="log-level">{t("Error level")}</Label>
            <Select items={LOG_LEVELS.map((value) => ({ value, label: value }))} value={logLevel} onValueChange={(next) => next && setLogLevel(next)}>
              <SelectTrigger id="log-level" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {LOG_LEVELS.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="log-days">{t("Days to keep")}</Label>
            <Input id="log-days" type="number" min="1" max="365" className="w-28" value={logDays} onChange={(event) => setLogDays(Number(event.target.value))} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Locked for security")}</CardTitle>
          <CardDescription>{t("They keep each account inside its home directory. They cannot be changed.")}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-2 text-sm sm:grid-cols-[11rem_1fr]">
            {lockedFor(username).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="flex items-center gap-1.5 font-mono text-muted-foreground"><LockIcon className="size-3.5" />{key}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <ActionFeedback action={save} />
      <ActionFeedback action={restart} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending}>{t("Save and apply")}</Button>
        <Button type="button" variant="outline" disabled={restart.isPending} onClick={() => restart.mutate()}>{t("Restart account PHP")}</Button>
      </div>
      <p className="text-sm text-muted-foreground">{t("Applying restarts OpenLiteSpeed and the account PHP: sites are briefly interrupted. Restarting PHP only interrupts the account's in-flight requests.")}</p>
    </form>
  );
}

export function VhostDetailPage() {
  const { t } = useTranslation();
  const { username, id } = route.useParams();
  const vhostId = Number(id);
  const account = useQuery({
    queryKey: ["accounts", username],
    queryFn: () => api.get<AccountDto>(`/accounts/${username}`),
    // Queued deployments start on their own: refresh while one is running or waiting.
    refetchInterval: (query) => {
      const app = query.state.data?.vhosts.find((item) => item.id === vhostId)?.app;
      return app && (app.status === "deploying" || app.queue.length > 0) ? 3000 : false;
    },
  });
  const vhost = account.data?.vhosts.find((item) => item.id === vhostId);
  const [tab, setTab] = useState<VhostTab>(route.useSearch().tab ?? "options");

  return (
    <Page>
      <div>
        <Button variant="link" className="h-auto p-0" nativeButton={false} render={<Link to="/accounts/$username" params={{ username }} />}>← {username}</Button>
        <h2 className="mt-1 text-lg font-medium">{vhost?.name ?? ""}</h2>
        {vhost && <p className="text-sm text-muted-foreground">{vhost.hostname} · <span className="font-mono">{vhost.slug}</span></p>}
      </div>
      {account.isPending && <Skeleton className="h-48 w-full" />}
      {account.isError && <p className="text-sm text-destructive">{account.error.message}</p>}
      {account.data && !vhost && <p className="text-sm text-muted-foreground">{t("The environment does not exist.")}</p>}
      {account.data && vhost && <VhostGeneralCard key={`${vhost.id}-${vhost.slug}-${vhost.name}-${vhost.hostname}`} account={account.data} vhost={vhost} />}
      {account.data && vhost?.app && <AppPanel account={account.data} vhost={vhost} app={vhost.app} />}
      {account.data && vhost && !vhost.app && (
        <Tabs value={tab} onValueChange={(next) => isVhostTab(next) && setTab(next)} className="gap-4">
          <TabsList>
            <TabsTrigger value="options">{t("Options")}</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="ftp">FTP</TabsTrigger>
            <TabsTrigger value="app">{t("Convert to app")}</TabsTrigger>
          </TabsList>
          {tab === "ftp" && vhost.ftp && <div role="tabpanel"><SiteFtpCard username={username} vhost={vhost} ftp={vhost.ftp} suspended={account.data.suspended} /></div>}
          {tab === "app" && <div role="tabpanel"><AppConfigForm account={account.data} vhost={vhost} /></div>}
          {/* Stays mounted while hidden: viewing logs must not discard unsaved edits. */}
          <div role="tabpanel" hidden={tab !== "options"}><VhostForm key={`${vhost.id}-${vhost.docRoot}`} username={username} vhost={vhost} /></div>
          {/* Mounted only while visible: leaving the tab stops polling the server every 3 seconds. */}
          {tab === "logs" && <div role="tabpanel"><LogsPanel vhost={vhost} /></div>}
        </Tabs>
      )}
    </Page>
  );
}
