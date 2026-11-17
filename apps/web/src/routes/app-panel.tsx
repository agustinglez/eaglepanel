import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RESERVED_ENV,
  RUNTIME_VERSIONS,
  appReservedMemory,
  startRebuilds,
  type AccountDto,
  type AppConfig,
  type AppDto,
  type AppKind,
  type AppRuntime,
  type DeploymentDto,
  type DeployRequestDto,
  type EnvScope,
  type JobCreatedDto,
  type VhostDto,
} from "@eaglepanel/shared";
import { EyeIcon, EyeOffIcon, PlayIcon, RefreshCwIcon, RocketIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ActionFeedback, CopyField, useJobAction } from "@/components/job-action";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatBytes, formatDateTime, formatUptime } from "@/lib/format";
import { serverText } from "@/lib/i18n";

/** `--bun` makes project scripts run with Bun even if they call `node`: there is no Node on the server. */
const PRESETS: Record<string, { label: string; config: Pick<AppConfig, "kind" | "runtime" | "runtimeVersion" | "buildCommand" | "startCommand" | "outputDir"> }> = {
  spa: { label: "SPA or static (Vite)", config: { kind: "static", runtime: "bun", runtimeVersion: "1", buildCommand: "bun install --frozen-lockfile && bun run build", startCommand: "", outputDir: "dist" } },
  next: { label: "Next.js", config: { kind: "server", runtime: "bun", runtimeVersion: "1", buildCommand: "bun install --frozen-lockfile && bun --bun run build", startCommand: "bun --bun run start", outputDir: "" } },
  api: { label: "API", config: { kind: "server", runtime: "bun", runtimeVersion: "1", buildCommand: "bun install --frozen-lockfile", startCommand: "bun --bun run start", outputDir: "" } },
};
const KINDS: { value: AppKind; label: string }[] = [
  { value: "static", label: "Static site" },
  { value: "server", label: "Server" },
];
const RUNTIMES = ([["bun", "Bun"], ["node", "Node"]] as const).filter(([value]) => RUNTIME_VERSIONS[value].length > 0).map(([value, label]) => ({ value, label }));
const SCOPES: { value: EnvScope; label: string }[] = [
  { value: "runtime", label: "At runtime" },
  { value: "build", label: "At build" },
  { value: "both", label: "Both" },
];
const STATUS: Record<AppDto["status"], { label: string; variant: "outline" | "secondary" | "destructive" }> = {
  new: { label: "Not deployed", variant: "secondary" },
  deploying: { label: "Deploying", variant: "secondary" },
  online: { label: "Online", variant: "outline" },
  stopped: { label: "Stopped", variant: "secondary" },
  failed: { label: "Failing", variant: "destructive" },
};

export function SimpleSelect<T extends string>({ id, value, options, onChange, className }: { id?: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; className?: string }) {
  const { t } = useTranslation();
  const items = options.map((option) => ({ value: option.value, label: t(option.label) }));
  return (
    <Select items={items} value={value} onValueChange={(next) => next && onChange(next as T)}>
      <SelectTrigger id={id} className={className ?? "w-full"}><SelectValue /></SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {items.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

const memoryFree = (account: AccountDto, fqdn: string) =>
  account.limits.appMemoryMb - account.vhosts.filter((vhost) => vhost.fqdn !== fqdn && vhost.app).reduce((total, vhost) => total + (vhost.app ? appReservedMemory(vhost.app.config) : 0), 0);

/** Used both to convert a PHP environment and to edit an app's configuration. */
export function AppConfigForm({ account, vhost }: { account: AccountDto; vhost: VhostDto }) {
  const { t } = useTranslation();
  const defaultMemory = Math.min(256, Math.max(64, memoryFree(account, vhost.fqdn)));
  const initial: AppConfig = vhost.app?.config ?? { repoUrl: "", branch: "main", subdir: "", healthPath: "/", spaFallback: true, memoryMb: 0, ...PRESETS.spa!.config };
  const [config, setConfig] = useState<AppConfig>(initial);
  const save = useJobAction(() => api.post<JobCreatedDto>(`/vhosts/${vhost.fqdn}/app`, config));
  const available = memoryFree(account, vhost.fqdn);
  const set = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => setConfig({ ...config, [key]: value });
  // A static site reserves no memory: switching to server proposes a value that fits in the account.
  const setKind = (kind: AppKind) => setConfig({ ...config, kind, memoryMb: kind === "server" ? config.memoryMb || defaultMemory : 0 });
  const applyPreset = (preset: (typeof PRESETS)[string]) =>
    setConfig({ ...config, ...preset.config, memoryMb: preset.config.kind === "server" ? config.memoryMb || defaultMemory : 0 });
  const isNew = !vhost.app;
  const isServer = config.kind === "server";
  const kindChanged = vhost.app !== null && vhost.app.config.kind !== config.kind;
  const overMemory = isServer && config.memoryMb > available;

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="flex max-w-3xl flex-col gap-4">
      {isNew && (
        <Alert>
          <AlertTitle>{t("Convert to app")}</AlertTitle>
          <AlertDescription>{t("The environment stops serving PHP and publishes what is deployed from Git. Files in its directory are not touched. It responds with 503 until the first deployment.")}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t("Type")}</CardTitle>
          <CardDescription>
            {isServer
              ? t("A process that serves requests, like Workers. It runs in its own container, with the memory you assign.")
              : t("Built on every deployment; OLS serves the files the build produces, like Pages. No process runs and no account memory is used.")}
          </CardDescription>
          <CardAction>
            <SimpleSelect
              value={"" as string}
              className="w-48"
              options={[{ value: "", label: "Template…" }, ...Object.entries(PRESETS).map(([value, preset]) => ({ value, label: preset.label }))]}
              onChange={(value) => { const preset = PRESETS[value]; if (preset) applyPreset(preset); }}
            />
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Type")} htmlFor="kind"><SimpleSelect<AppKind> id="kind" value={config.kind} options={KINDS} onChange={setKind} /></Field>
          {kindChanged && (
            <div className="sm:col-span-2">
              <Alert>
                <AlertTitle>{t("The type changes")}</AlertTitle>
                <AlertDescription>{t("Current releases do not work for the other type: they are deleted and the environment responds with 503 until the next deployment.")}</AlertDescription>
              </Alert>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("Repository")}</CardTitle>
          <CardDescription>
            {t("Code is fetched from Git on every deployment. A public repository uses HTTPS. A private one uses SSH (git@github.com:user/repo.git) and needs a deploy key: the panel generates it for this app and you add it to GitHub.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="URL" htmlFor="repo"><Input id="repo" value={config.repoUrl} onChange={(event) => set("repoUrl", event.target.value.trim())} placeholder="git@github.com:user/repo.git" spellCheck={false} required /></Field>
          </div>
          {isSshRepo(config.repoUrl) && <div className="sm:col-span-2"><DeployKeyField vhost={vhost} /></div>}
          <Field label={t("Branch")} htmlFor="branch"><Input id="branch" value={config.branch} onChange={(event) => set("branch", event.target.value.trim())} spellCheck={false} required /></Field>
          <Field label={t("Subdirectory")} htmlFor="subdir" hint={t("Monorepos only.")}><Input id="subdir" value={config.subdir} onChange={(event) => set("subdir", event.target.value.trim().replace(/^\/+|\/+$/g, ""))} placeholder="apps/api" spellCheck={false} /></Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Build and run")}</CardTitle>
          <CardDescription>
            {isServer
              ? t("The build runs once per deployment and the start command on every start. The app must listen on the PORT variable.")
              : t("The build runs on every deployment. OLS serves what it leaves in the output directory.")}
            {" "}{t("Commands run with Bun and with the account's permissions, in its container.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Runtime" htmlFor="runtime">
            <SimpleSelect<AppRuntime> id="runtime" value={config.runtime} options={[...RUNTIMES]} onChange={(runtime) => setConfig({ ...config, runtime, runtimeVersion: RUNTIME_VERSIONS[runtime][0]! })} />
          </Field>
          <Field label={t("Version")} htmlFor="runtime-version" hint={t("Each deployment uses the latest release of the series.")}>
            <SimpleSelect id="runtime-version" value={config.runtimeVersion} options={RUNTIME_VERSIONS[config.runtime].map((value) => ({ value, label: `${config.runtime === "node" ? "Node" : "Bun"} ${value}` }))} onChange={(value) => set("runtimeVersion", value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Build" htmlFor="build" hint={isServer ? t("Install dependencies and build. Leave empty if not needed.") : t("Install dependencies and build.")}>
              <Input id="build" className="font-mono" value={config.buildCommand} onChange={(event) => set("buildCommand", event.target.value)} placeholder="bun install --frozen-lockfile && bun run build" spellCheck={false} />
            </Field>
          </div>
          {isServer ? (
            <>
              <div className="sm:col-span-2">
                <Field label={t("Start")} htmlFor="start">
                  <Input id="start" className="font-mono" value={config.startCommand} onChange={(event) => set("startCommand", event.target.value)} placeholder="bun --bun run start" spellCheck={false} required />
                </Field>
              </div>
              {startRebuilds(config.startCommand) && (
                <div className="sm:col-span-2">
                  <Alert>
                    <AlertTitle>{t("The start command rebuilds")}</AlertTitle>
                    <AlertDescription>{t("Every restart will take as long as the build, and if it fails there is no previous release left serving traffic. Move installation and build steps to the Build field.")}</AlertDescription>
                  </Alert>
                </div>
              )}
              <Field label={t("Health check path")} htmlFor="health" hint={t("It must respond before receiving traffic.")}><Input id="health" className="font-mono" value={config.healthPath} onChange={(event) => set("healthPath", event.target.value)} spellCheck={false} required /></Field>
              <Field label={t("Maximum memory (MB)")} htmlFor="memory" hint={t("Available in the account: {{available}} MB.", { available })}>
                <Input id="memory" type="number" min="64" step="64" value={config.memoryMb} onChange={(event) => set("memoryMb", Number(event.target.value))} aria-invalid={overMemory} />
              </Field>
            </>
          ) : (
            <>
              <Field label={t("Output directory")} htmlFor="output" hint={t("Relative to the project. Empty means the root.")}>
                <Input id="output" className="font-mono" value={config.outputDir} onChange={(event) => set("outputDir", event.target.value.trim().replace(/^\/+|\/+$/g, ""))} placeholder="dist" spellCheck={false} />
              </Field>
              <div className="flex items-start gap-3 pt-6">
                <Switch id="spa" checked={config.spaFallback} onCheckedChange={(checked) => set("spaFallback", checked)} />
                <div className="grid gap-1">
                  <Label htmlFor="spa">SPA</Label>
                  <p className="text-sm text-muted-foreground">{t("Paths that are not files return index.html.")}</p>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <ActionFeedback action={save} />
      <div><Button type="submit" disabled={save.isPending || overMemory}>{isNew ? t("Convert to app") : t("Save")}</Button></div>
      {!isNew && <p className="text-sm text-muted-foreground">{t("Changes take effect on the next deployment.")}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------- Webhook

/** A repository URL that is not HTTPS is cloned over SSH and needs a deploy key. */
const isSshRepo = (url: string) => url !== "" && !url.startsWith("https://");

/**
 * The app's deploy key, next to the repository URL, which is where it is needed. The agent generates it on demand;
 * before the app is saved it does not exist yet, so only when it becomes available is explained.
 */
function DeployKeyField({ vhost }: { vhost: VhostDto }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = useMutation({
    mutationFn: () => api.post<{ publicKey: string }>(`/vhosts/${vhost.fqdn}/app/deploy-key`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
  });
  const instructions = t("In GitHub: Settings → Deploy keys → Add deploy key, without write access.");
  if (!vhost.app) {
    return <p className="text-sm text-muted-foreground">{t("Private repository over SSH: after converting the environment to an app, you can generate its deploy key here and in Summary.")} {instructions}</p>;
  }
  if (!vhost.app.deployKey) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <p className="text-sm">{t("This app has no deploy key yet. Generate it, copy it and add it to the repository.")} {instructions}</p>
        <div><Button type="button" size="sm" variant="outline" disabled={key.isPending} onClick={() => key.mutate()}>{t("Generate key")}</Button></div>
        {key.isError && <p className="text-sm text-destructive">{key.error.message}</p>}
      </div>
    );
  }
  return (
    <Field label={t("Deploy key")} hint={instructions}>
      <CopyField value={vhost.app.deployKey} mono />
    </Field>
  );
}

function AutoDeployCard({ vhost, app }: { vhost: VhostDto; app: AppDto }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ ok: true }>(`/vhosts/${vhost.fqdn}/webhook`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
  });
  const { secret, urls } = app.webhook;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Automatic deployment")}</CardTitle>
        <CardDescription>
          {secret
            ? t("Every push to {{branch}} deploys this app. In GitHub: Settings → Webhooks → Add webhook, with Content type application/json, this secret and only the push event.", { branch: app.config.branch })
            : t("With a GitHub webhook, every push to {{branch}} deploys the app without opening the panel.", { branch: app.config.branch })}
        </CardDescription>
        <CardAction><Badge variant="outline">{secret ? t("Active") : t("Inactive")}</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {secret && (
          <>
            {urls.length === 0 && (
              <Alert>
                <AlertTitle>{t("A public URL is missing")}</AlertTitle>
                <AlertDescription>{t("Choose a webhook domain in the account settings, or configure the global domain in the panel settings.")}</AlertDescription>
              </Alert>
            )}
            {urls.map((url) => <Field key={url} label="Payload URL"><CopyField value={url} mono /></Field>)}
            <Field label="Secret"><CopyField value={secret} mono /></Field>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          {secret
            ? (
              <>
                <AlertDialog>
                  <AlertDialogTrigger render={<Button variant="outline" disabled={toggle.isPending} />}>{t("Regenerate secret")}</AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("Regenerate the secret?")}</AlertDialogTitle>
                      <AlertDialogDescription>{t("The GitHub webhook stops deploying until you enter the new secret.")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => toggle.mutate(true)}>{t("Regenerate")}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <Button variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate(false)}>{t("Disable")}</Button>
              </>
            )
            : <Button variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate(true)}>{t("Enable")}</Button>}
        </div>
        {toggle.isError && <Alert variant="destructive"><AlertDescription>{toggle.error?.message}</AlertDescription></Alert>}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------- Summary

function useAppStatus(fqdn: string, enabled: boolean) {
  return useQuery({
    queryKey: ["app-status", fqdn],
    queryFn: () => api.get<{ state: string; restarts: number; memoryBytes: number | null; sinceMs: number | null }>(`/vhosts/${fqdn}/app/status`),
    refetchInterval: 5000,
    enabled,
  });
}

function SummaryTab({ account, vhost, app }: { account: AccountDto; vhost: VhostDto; app: AppDto }) {
  const { t } = useTranslation();
  const isServer = app.config.kind === "server";
  const status = useAppStatus(vhost.fqdn, isServer && app.currentRelease !== null);
  const deploy = useJobAction(() => api.post<DeployRequestDto>(`/vhosts/${vhost.fqdn}/deploy`));
  const control = useJobAction((action: "start" | "stop" | "restart") => api.post<JobCreatedDto>(`/vhosts/${vhost.fqdn}/app/${action}`));
  const queryClient = useQueryClient();
  // Not a job: the agent generates it on demand. The account must be reloaded to show it.
  const key = useMutation({
    mutationFn: () => api.post<{ publicKey: string }>(`/vhosts/${vhost.fqdn}/app/deploy-key`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
  });
  const ssh = !app.config.repoUrl.startsWith("https://");
  const busy = app.status === "deploying" || account.suspended || deploy.isPending;
  // Deploying does not wait: if one is running, the request is queued.
  const canDeploy = !account.suspended && !deploy.isPending && !(ssh && !app.deployKey);
  const live = status.data;

  return (
    <div className="flex flex-col gap-4">
      {app.status === "failed" && (
        <Alert variant="destructive">
          <AlertTitle>{t("The app is not online")}</AlertTitle>
          <AlertDescription>{t("The last deployment failed or the app did not stay running. Check the log in Deployments or the output in Logs.")}</AlertDescription>
        </Alert>
      )}
      {ssh && !app.deployKey && (
        <Alert>
          <AlertTitle>{t("The deploy key is missing")}</AlertTitle>
          <AlertDescription>
            <span>{t("The repository uses SSH: generate the key and add it to the repository as a read-only key.")}</span>
            <div className="mt-2"><Button size="sm" variant="outline" onClick={() => key.mutate()} disabled={key.isPending}>{t("Generate key")}</Button></div>
          </AlertDescription>
        </Alert>
      )}
      {app.deployKey && (
        <Card>
          <CardHeader>
            <CardTitle>{t("Deploy key")}</CardTitle>
            <CardDescription>{t("In GitHub: Settings → Deploy keys → Add deploy key, without write access.")}</CardDescription>
          </CardHeader>
          <CardContent><CopyField value={app.deployKey} mono /></CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{vhost.fqdn}</CardTitle>
          <CardDescription>{isServer ? t("Server") : t("Static site")} · {app.config.runtime === "node" ? "Node" : "Bun"} {app.config.runtimeVersion} · {app.config.repoUrl} · {app.config.branch}</CardDescription>
          <CardAction><Badge variant={STATUS[app.status].variant}>{!isServer && app.status === "online" ? t("Published") : t(STATUS[app.status].label)}</Badge></CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div className="grid gap-1"><dt className="text-muted-foreground">{t("Active commit")}</dt><dd className="font-mono font-medium">{app.commit?.slice(0, 7) ?? "—"}</dd></div>
            <div className="grid gap-1"><dt className="text-muted-foreground">{t("Release")}</dt><dd className="font-medium">{app.currentRelease ?? "—"}</dd></div>
            {isServer ? (
              <>
                <div className="grid gap-1"><dt className="text-muted-foreground">{t("Uptime")}</dt><dd className="font-medium">{live?.state === "active" && live.sinceMs ? formatUptime(Math.max(0, (Date.now() - live.sinceMs) / 1000)) : "—"}</dd></div>
                <div className="grid gap-1"><dt className="text-muted-foreground">{t("Memory")}</dt><dd className="font-medium">{live?.memoryBytes ? t("{{used}} of {{limit}}", { used: formatBytes(live.memoryBytes), limit: `${app.config.memoryMb} MB` }) : "—"}</dd></div>
              </>
            ) : (
              <div className="grid gap-1 sm:col-span-2"><dt className="text-muted-foreground">{t("Output directory")}</dt><dd className="font-mono font-medium">{app.config.outputDir || t("project root")}{app.config.spaFallback ? " · SPA" : ""}</dd></div>
            )}
          </dl>
          {live && live.restarts > 0 && <p className="text-sm text-muted-foreground">{t("Restarted {{count}} times since the last start.", { count: live.restarts })}</p>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={!canDeploy} onClick={() => deploy.mutate()}><RocketIcon />{app.currentRelease ? t("Redeploy") : t("Deploy")}</Button>
            {isServer && app.currentRelease !== null && (
              <>
                <Button variant="outline" disabled={busy} onClick={() => control.mutate("restart")}><RefreshCwIcon />{t("Restart")}</Button>
                {app.status === "stopped"
                  ? <Button variant="outline" disabled={busy} onClick={() => control.mutate("start")}><PlayIcon />{t("Start")}</Button>
                  : <Button variant="outline" disabled={app.status === "deploying"} onClick={() => control.mutate("stop")}><SquareIcon />{t("Stop")}</Button>}
              </>
            )}
          </div>
          <ActionFeedback action={deploy} />
          {deploy.data && deploy.data.jobId === null && (
            <Alert>
              <AlertDescription>{t("Queued at position {{position}}: it starts when the previous ones finish. You can follow it in Deployments.", { position: deploy.data.position })}</AlertDescription>
            </Alert>
          )}
          {app.queue.length > 0 && !deploy.data && <p className="text-sm text-muted-foreground">{t("{{count}} deployments queued.", { count: app.queue.length })}</p>}
          <ActionFeedback action={control} />
          {key.isError && <Alert variant="destructive"><AlertDescription>{key.error?.message}</AlertDescription></Alert>}
        </CardContent>
      </Card>
      <AutoDeployCard vhost={vhost} app={app} />
    </div>
  );
}

// ---------------------------------------------------------------------------- Deployments

function DeploymentsTab({ vhost, app }: { vhost: VhostDto; app: AppDto }) {
  const { t } = useTranslation();
  const list = useQuery({ queryKey: ["deployments", vhost.fqdn, app.currentRelease, app.status], queryFn: () => api.get<DeploymentDto[]>(`/vhosts/${vhost.fqdn}/deployments`), refetchInterval: app.status === "deploying" ? 3000 : false });
  const [viewing, setViewing] = useState<DeploymentDto | null>(null);
  const log = useQuery({ queryKey: ["deployment-log", viewing?.id], queryFn: () => api.get<{ log: string }>(`/vhosts/${vhost.fqdn}/deployments/${viewing?.id}/log`), enabled: viewing !== null, refetchInterval: viewing?.status === "running" ? 2000 : false });
  const rollback = useJobAction((id: number) => api.post<JobCreatedDto>(`/vhosts/${vhost.fqdn}/deployments/${id}/rollback`));
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: (id: number) => api.post<{ ok: true }>(`/vhosts/${vhost.fqdn}/queue/${id}/cancel`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Deployments")}</CardTitle>
        <CardDescription>{t("Deployments run one at a time, in the order they were requested. The last 3 successful releases are kept, to roll back without rebuilding.")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {app.queue.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t("Queued")}</h3>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader className="bg-muted">
                  <TableRow>
                    <TableHead>{t("Position")}</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>{t("Trigger")}</TableHead>
                    <TableHead>{t("Date")}</TableHead>
                    <TableHead className="text-right">{t("Actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {app.queue.map((item, index) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{index + 1}</TableCell>
                      <TableCell className={item.commit ? "font-mono" : "text-muted-foreground"}>{item.commit?.slice(0, 7) ?? t("Latest on branch")}</TableCell>
                      <TableCell className="max-w-64 truncate">{serverText(item.trigger)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(item.requestedAt)}</TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <Button variant="ghost" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(item.id)}>{t("Cancel")}</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {cancel.isError && <Alert variant="destructive"><AlertDescription>{cancel.error?.message}</AlertDescription></Alert>}
          </div>
        )}
        {list.data?.length === 0 && app.queue.length === 0 && <p className="text-sm text-muted-foreground">{t("No deployments yet.")}</p>}
        {list.data && list.data.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead>{t("Release")}</TableHead>
                  <TableHead>Commit</TableHead>
                  <TableHead>{t("Message")}</TableHead>
                  <TableHead>{t("Date")}</TableHead>
                  <TableHead>{t("Status")}</TableHead>
                  <TableHead className="text-right">{t("Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.map((deployment) => (
                  <TableRow key={deployment.id}>
                    <TableCell className="font-medium">{deployment.release}</TableCell>
                    <TableCell className="font-mono">{deployment.commit?.slice(0, 7) ?? "—"}</TableCell>
                    <TableCell className="max-w-64 truncate">{deployment.message ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(deployment.startedAt)}</TableCell>
                    <TableCell>
                      {deployment.active && <Badge>{t("Active")}</Badge>}
                      {!deployment.active && deployment.status === "succeeded" && <Badge variant="outline">{deployment.available ? t("Available") : t("Not kept")}</Badge>}
                      {deployment.status === "failed" && <Badge variant="destructive">{t("Failed")}</Badge>}
                      {deployment.status === "running" && <Badge variant="secondary">{t("Running")}</Badge>}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setViewing(deployment)}>{t("View log")}</Button>
                        {deployment.available && !deployment.active && (
                          <AlertDialog>
                            <AlertDialogTrigger render={<Button variant="outline" size="sm" />}>{t("Roll back")}</AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>{t("Roll back to release {{release}}?", { release: deployment.release })}</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {app.config.kind === "server"
                                    ? t("That release starts next to the active one and receives traffic once it responds, without rebuilding. It uses the current variables.")
                                    : t("OLS starts serving the files of that release, without rebuilding.")}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                                <AlertDialogAction onClick={() => rollback.mutate(deployment.id)}>{t("Roll back to this release")}</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <ActionFeedback action={rollback} />
      </CardContent>
      <Dialog open={viewing !== null} onOpenChange={(next) => !next && setViewing(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("Release {{release}}", { release: viewing?.release })}</DialogTitle>
            <DialogDescription>{viewing?.message ?? ""}</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{log.data?.log || (log.isPending ? t("Loading…") : t("No output."))}</pre>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------- Variables

function VariablesTab({ vhost, app }: { vhost: VhostDto; app: AppDto }) {
  const { t } = useTranslation();
  const [vars, setVars] = useState(app.env);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<EnvScope>("runtime");
  const [pasted, setPasted] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const save = useJobAction(() => api.post<JobCreatedDto>(`/vhosts/${vhost.fqdn}/env`, { vars }));
  const dirty = JSON.stringify(vars) !== JSON.stringify(app.env);

  function add(event: SyntheticEvent) {
    event.preventDefault();
    if (RESERVED_ENV.has(key)) {
      setNotice(t("{{name}} is set by the panel and cannot be changed.", { name: key }));
      return;
    }
    setNotice("");
    setVars([...vars.filter((item) => item.key !== key), { key, value, scope }].sort((a, b) => a.key.localeCompare(b.key)));
    setKey("");
    setValue("");
  }

  function importEnv(event: SyntheticEvent) {
    event.preventDefault();
    const parsed = pasted.split("\n").flatMap((line) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match?.[1]) return [];
      const raw = match[2] ?? "";
      const unquoted = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
      return [{ key: match[1].toUpperCase(), value: unquoted, scope: "runtime" as EnvScope }];
    });
    // The ones the panel sets are skipped, and the person is told which.
    const skipped = parsed.filter((item) => RESERVED_ENV.has(item.key)).map((item) => item.key);
    setNotice(skipped.length > 0 ? t("Not imported, the panel sets them: {{names}}", { names: skipped.join(", ") }) : "");
    const keep = parsed.filter((item) => !RESERVED_ENV.has(item.key));
    const keys = new Set(keep.map((item) => item.key));
    setVars([...vars.filter((item) => !keys.has(item.key)), ...keep].sort((a, b) => a.key.localeCompare(b.key)));
    setPasted("");
    setPasteOpen(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Environment variables")}</CardTitle>
        <CardDescription>
          {app.config.kind === "server"
            ? t("The app receives PORT and DATA_DIR from the panel, and NODE_ENV=production unless you set it. Build variables apply on redeploy; the rest, on restart.")
            : t("A static site only uses build variables: they end up written into the published files, so do not put secrets in them. They apply on redeploy.")}
        </CardDescription>
        <CardAction>
          <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
            <DialogTrigger render={<Button variant="outline" size="sm" />}>{t("Paste .env")}</DialogTrigger>
            <DialogContent className="sm:max-w-xl">
              <form onSubmit={importEnv} className="grid gap-4">
                <DialogHeader>
                  <DialogTitle>{t("Paste .env")}</DialogTitle>
                  <DialogDescription>{t("Existing variables are replaced. They are added as \"At runtime\".")}</DialogDescription>
                </DialogHeader>
                <Textarea rows={8} className="font-mono" value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder={"API_URL=https://...\nSECRET=..."} spellCheck={false} autoComplete="off" />
                <DialogFooter><Button type="submit" disabled={!pasted.trim()}>{t("Import")}</Button></DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {vars.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead>{t("Name")}</TableHead>
                  <TableHead>{t("Value")}</TableHead>
                  <TableHead className="w-40">{t("Used")}</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {vars.map((item) => (
                  <TableRow key={item.key}>
                    <TableCell className="font-mono">{item.key}</TableCell>
                    <TableCell className="max-w-72 truncate font-mono text-muted-foreground">{revealed === item.key ? item.value : "••••••••••••"}</TableCell>
                    <TableCell><SimpleSelect value={item.scope} options={SCOPES} onChange={(next) => setVars(vars.map((env) => (env.key === item.key ? { ...env, scope: next } : env)))} /></TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button variant="ghost" size="icon-sm" aria-label={t("Show {{name}}", { name: item.key })} onClick={() => setRevealed(revealed === item.key ? null : item.key)}>{revealed === item.key ? <EyeOffIcon /> : <EyeIcon />}</Button>
                        <Button variant="ghost" size="icon-sm" aria-label={t("Delete {{name}}", { name: item.key })} onClick={() => setVars(vars.filter((env) => env.key !== item.key))}><Trash2Icon /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <form onSubmit={add} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_10rem_auto]">
          <Field label={t("Name")} htmlFor="env-key"><Input id="env-key" className="font-mono" value={key} aria-invalid={RESERVED_ENV.has(key) || undefined} onChange={(event) => { setKey(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "")); setNotice(""); }} placeholder="API_KEY" spellCheck={false} required /></Field>
          <Field label={t("Value")} htmlFor="env-value"><Input id="env-value" className="font-mono" value={value} onChange={(event) => setValue(event.target.value)} spellCheck={false} autoComplete="off" /></Field>
          <Field label={t("Used")} htmlFor="env-scope"><SimpleSelect id="env-scope" value={scope} options={SCOPES} onChange={setScope} /></Field>
          <Button type="submit" variant="outline">{t("Add")}</Button>
        </form>
        {notice && <p role="alert" className="text-sm text-destructive">{notice}</p>}
        <ActionFeedback action={save} />
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{t("Save variables")}</Button>
          {dirty && <span className="text-sm text-muted-foreground">{t("There are unsaved changes.")}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------- Logs

function AppLogsTab({ vhost }: { vhost: VhostDto }) {
  const { t } = useTranslation();
  const [live, setLive] = useState(true);
  const logs = useQuery({
    queryKey: ["app-logs", vhost.fqdn],
    queryFn: () => api.get<{ lines: string[] }>(`/vhosts/${vhost.fqdn}/app/logs?lines=200`),
    refetchInterval: (query) => (live && !query.state.error ? 3000 : false),
  });
  const output = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const element = output.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [logs.data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("App output")}</CardTitle>
        <CardDescription>{t("What the app writes to stdout and stderr, last 200 lines.")}</CardDescription>
        <CardAction className="flex items-center gap-2">
          <Label htmlFor="app-live" className="font-normal">{t("Live")}</Label>
          <Switch id="app-live" checked={live} onCheckedChange={setLive} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {logs.isError && <Alert variant="destructive"><AlertDescription>{logs.error.message}</AlertDescription></Alert>}
        <pre ref={output} onScroll={(event) => { const element = event.currentTarget; atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }} className="h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
          {logs.data?.lines.length ? logs.data.lines.join("\n") : t("No output yet.")}
        </pre>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------- Configuration

function ConfigTab({ account, vhost }: { account: AccountDto; vhost: VhostDto }) {
  const { t } = useTranslation();
  const toPhp = useJobAction(() => api.post<JobCreatedDto>(`/vhosts/${vhost.fqdn}/to-php`));
  return (
    <div className="flex flex-col gap-4">
      <AppConfigForm key={JSON.stringify(vhost.app?.config)} account={account} vhost={vhost} />
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t("Switch to PHP")}</CardTitle>
          <CardDescription>{t("Stops the app and deletes its code, releases and key. What it stored in DATA_DIR stays in the account's home directory.")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="outline" />}>{t("Switch to PHP")}</AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("Switch {{name}} to PHP?", { name: vhost.fqdn })}</AlertDialogTitle>
                  <AlertDialogDescription>{t("The app is stopped and its deployments and variables are deleted. This cannot be undone.")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => toPhp.mutate()}>{t("Switch to PHP")}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
          <ActionFeedback action={toPhp} />
        </CardContent>
      </Card>
    </div>
  );
}

const APP_TABS = [
  { value: "summary", label: "Summary" },
  { value: "deployments", label: "Deployments" },
  { value: "variables", label: "Variables" },
  { value: "logs", label: "Logs" },
  { value: "config", label: "Configuration" },
] as const;
type AppTab = (typeof APP_TABS)[number]["value"];

export function AppPanel({ account, vhost, app }: { account: AccountDto; vhost: VhostDto; app: AppDto }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<AppTab>("summary");
  // A static site has no process: there is no output to show.
  const tabs = APP_TABS.filter(({ value }) => value !== "logs" || app.config.kind === "server");
  return (
    <Tabs value={tab} onValueChange={(next) => setTab(next as AppTab)} className="gap-4">
      <TabsList>
        {tabs.map(({ value, label }) => <TabsTrigger key={value} value={value}>{t(label)}</TabsTrigger>)}
      </TabsList>
      {/* Each tab is mounted only while visible, so tabs that poll the server stop when hidden. */}
      {tab === "summary" && <div role="tabpanel"><SummaryTab account={account} vhost={vhost} app={app} /></div>}
      {tab === "deployments" && <div role="tabpanel"><DeploymentsTab vhost={vhost} app={app} /></div>}
      {tab === "variables" && <div role="tabpanel"><VariablesTab key={JSON.stringify(app.env)} vhost={vhost} app={app} /></div>}
      {tab === "logs" && <div role="tabpanel"><AppLogsTab vhost={vhost} /></div>}
      {tab === "config" && <div role="tabpanel"><ConfigTab account={account} vhost={vhost} /></div>}
    </Tabs>
  );
}
