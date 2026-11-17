import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BACKUP_RETENTION, type AccountDto, type AccountExportDto, type BackupManifestSummaryDto, type BackupRunDto, type BackupSettingsDto, type JobCreatedDto } from "@eaglepanel/shared";
import { ArchiveRestoreIcon, DatabaseBackupIcon, DownloadIcon, PackageIcon, PlayIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ActionFeedback, SecretDialog, useJobAction } from "@/components/job-action";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { serverText } from "@/lib/i18n";

const HOUR_ITEMS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: `${String(hour).padStart(2, "0")}:00` }));

// ---------------------------------------------------------------------------- Settings

/** S3 or R2 storage for the backups of the whole server. */
export function BackupSettingsCard() {
  const { t } = useTranslation();
  const current = useQuery({ queryKey: ["backup-settings"], queryFn: () => api.get<BackupSettingsDto>("/settings/backups") });
  // Kept outside the form: saving remounts the form with the new data, which would lose it.
  const [password, setPassword] = useState<string | null>(null);
  if (!current.data) return null;
  return (
    <>
      <BackupSettingsForm key={JSON.stringify(current.data)} saved={current.data} onPassword={setPassword} />
      <SecretDialog
        title={t("Repository password")}
        description={t("Store it outside the server, in your password manager. Without it no backup can be read: if the server is lost, it is the only way to recover everything. It will not be shown again.")}
        secret={password}
        onClose={() => setPassword(null)}
      />
    </>
  );
}

function BackupSettingsForm({ saved, onPassword }: { saved: BackupSettingsDto; onPassword: (password: string) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    enabled: saved.configured ? saved.enabled : true,
    endpoint: saved.endpoint,
    bucket: saved.bucket,
    prefix: saved.prefix || "eaglepanel",
    region: saved.region || "auto",
    accessKeyId: saved.accessKeyId,
    secretAccessKey: "",
    hour: saved.hour,
  });
  const [existingPassword, setExistingPassword] = useState("");
  const save = useJobAction(() => api.post<JobCreatedDto>("/settings/backups", { ...form, ...(existingPassword ? { repositoryPassword: existingPassword } : {}) }));
  const runNow = useJobAction(() => api.post<JobCreatedDto>("/backups/run"));
  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((previous) => ({ ...previous, [key]: value }));

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Backups</CardTitle>
        <CardDescription>
          {t("Encrypted with restic, stored in an S3 or Cloudflare R2 bucket. Every night it saves each account's home directory, databases and everything needed to recreate it. Keeps {{daily}} daily and {{weekly}} weekly backups.", { daily: BACKUP_RETENTION.daily, weekly: BACKUP_RETENTION.weekly })}
        </CardDescription>
        <CardAction><Badge variant="outline">{!saved.configured ? t("Not configured") : saved.enabled ? t("Active") : t("Paused")}</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {saved.pendingPurges.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>{t("Backups of deleted accounts not removed")}</AlertTitle>
            <AlertDescription>{t("{{accounts}}: they could not be removed when the accounts were deleted. Retried on every daily backup.", { accounts: saved.pendingPurges.join(", ") })}</AlertDescription>
          </Alert>
        )}
        {saved.lastRun && (
          <Alert variant={saved.lastRun.ok ? "default" : "destructive"}>
            <AlertTitle>{t("Last backup: {{date}}", { date: formatDateTime(saved.lastRun.at) })} · {saved.lastRun.ok ? t("complete") : t("with errors")}</AlertTitle>
            <AlertDescription>{serverText(saved.lastRun.detail)}</AlertDescription>
          </Alert>
        )}
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2 sm:col-span-2">
            <Label htmlFor="backup-endpoint">Endpoint</Label>
            <Input id="backup-endpoint" value={form.endpoint} onChange={(event) => update("endpoint", event.target.value.trim())} placeholder="https://<account>.r2.cloudflarestorage.com" spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="backup-bucket">Bucket</Label>
            <Input id="backup-bucket" value={form.bucket} onChange={(event) => update("bucket", event.target.value.trim())} spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="backup-prefix">{t("Prefix")}</Label>
            <Input id="backup-prefix" value={form.prefix} onChange={(event) => update("prefix", event.target.value.trim())} spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="backup-key">Access key ID</Label>
            <Input id="backup-key" value={form.accessKeyId} onChange={(event) => update("accessKeyId", event.target.value.trim())} spellCheck={false} autoComplete="off" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="backup-secret">Secret access key</Label>
            <Input id="backup-secret" type="password" value={form.secretAccessKey} onChange={(event) => update("secretAccessKey", event.target.value.trim())} placeholder={saved.hasSecret ? t("Saved: leave empty to keep it") : ""} autoComplete="new-password" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="backup-region">{t("Region")}</Label>
            <Input id="backup-region" value={form.region} onChange={(event) => update("region", event.target.value.trim())} placeholder="auto" spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label>{t("Daily backup time")}</Label>
            <Select items={HOUR_ITEMS} value={String(form.hour)} onValueChange={(value) => value && update("hour", Number(value))}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{HOUR_ITEMS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </div>
          {!saved.configured && (
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="backup-existing">{t("Existing repository password (optional)")}</Label>
              <Input id="backup-existing" type="password" value={existingPassword} onChange={(event) => setExistingPassword(event.target.value)} autoComplete="off" placeholder={t("Only to connect this server to existing backups")} />
            </div>
          )}
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Switch checked={form.enabled} onCheckedChange={(on) => update("enabled", on)} />
            {t("Automatic daily backup")}
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" disabled={save.isPending || !form.endpoint || !form.bucket || !form.accessKeyId || (!saved.hasSecret && !form.secretAccessKey)}>{t("Save")}</Button>
            {saved.configured && <Button type="button" variant="outline" disabled={runNow.isPending} onClick={() => runNow.mutate()}><PlayIcon />{t("Back up now")}</Button>}
          </div>
        </form>
        <ActionFeedback action={save} onFinished={(ok) => {
          if (ok && save.data?.secret) onPassword(save.data.secret);
          void queryClient.invalidateQueries({ queryKey: ["backup-settings"] });
        }} />
        <ActionFeedback action={runNow} onFinished={() => void queryClient.invalidateQueries({ queryKey: ["backup-settings"] })} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------- Account

/** An account's backups and their restores, part by part. */
export function AccountBackups({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  const username = account.username;
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["backup-settings"], queryFn: () => api.get<BackupSettingsDto>("/settings/backups") });
  const runs = useQuery({
    queryKey: ["backups", username],
    queryFn: () => api.get<BackupRunDto[]>(`/accounts/${username}/backups`),
    enabled: settings.data?.configured === true,
  });
  const backupNow = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${username}/backups/run`));
  const restoreDb = useJobAction((input: { snapshot: string; database: string; manifest?: string }) => api.post<JobCreatedDto>(`/accounts/${username}/backups/restore-database`, input));
  const [restoringFiles, setRestoringFiles] = useState<BackupRunDto | null>(null);
  const [restoringConfig, setRestoringConfig] = useState<BackupRunDto | null>(null);
  const existing = new Set(account.databases.map(({ name }) => name));
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["backups", username] });

  if (settings.data && !settings.data.configured) {
    return (
      <Alert>
        <AlertTitle>{t("Backups are not configured")}</AlertTitle>
        <AlertDescription>{t("They are configured once for the whole server, in Settings.")}</AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Backups</CardTitle>
        <CardDescription>{t("Each backup contains the account's home directory, databases and configuration. Restores are done part by part.")}</CardDescription>
        <CardAction><Button variant="outline" size="sm" disabled={backupNow.isPending || account.suspended} onClick={() => backupNow.mutate()}><DatabaseBackupIcon />{t("Back up now")}</Button></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {account.suspended && <p className="text-sm text-muted-foreground">{t("The account is suspended and is not backed up while suspended. Its previous backups can still be restored.")}</p>}
        <ActionFeedback action={backupNow} onFinished={refresh} />
        <ActionFeedback action={restoreDb} />
        {runs.isError && <Alert variant="destructive"><AlertDescription>{runs.error.message}</AlertDescription></Alert>}
        {runs.data?.length === 0 && <p className="text-sm text-muted-foreground">{t("No backups for this account yet.")}</p>}
        {runs.data && runs.data.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead>{t("Date")}</TableHead>
                  <TableHead>{t("Files")}</TableHead>
                  <TableHead>{t("Databases")}</TableHead>
                  <TableHead className="text-right">{t("Restore")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.map((run) => (
                  <TableRow key={run.run}>
                    <TableCell className="font-medium">{formatDateTime(run.time)}</TableCell>
                    <TableCell className="text-muted-foreground">{run.files ? (run.sizeBytes !== null ? formatBytes(run.sizeBytes) : t("Yes")) : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{run.databases.length ? run.databases.map(({ name }) => name).join(", ") : "—"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-2">
                        {run.files && <Button variant="outline" size="sm" onClick={() => setRestoringFiles(run)}><ArchiveRestoreIcon />{t("Files")}</Button>}
                        {run.manifest && <Button variant="outline" size="sm" onClick={() => setRestoringConfig(run)}><SlidersHorizontalIcon />{t("Configuration")}</Button>}
                        {run.databases.map((database) => (
                          <AlertDialog key={database.snapshot}>
                            <AlertDialogTrigger render={<Button variant="outline" size="sm" />}>{database.name}</AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>{t("Restore {{name}}?", { name: database.name })}</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {existing.has(database.name)
                                    ? t("The database is emptied and loaded as it was on {{date}}. Any changes made since then are lost. Its user and password do not change.", { date: formatDateTime(run.time) })
                                    : t("It no longer exists in the account: it is recreated with its user and the same password it had, and loaded as it was on {{date}}. It counts toward the database limit.", { date: formatDateTime(run.time) })}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                                <AlertDialogAction onClick={() => restoreDb.mutate({ snapshot: database.snapshot, database: database.name, ...(run.manifest ? { manifest: run.manifest } : {}) })}>{t("Restore")}</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      {restoringFiles && <RestoreFilesDialog username={username} run={restoringFiles} onClose={() => setRestoringFiles(null)} />}
      {restoringConfig?.manifest && <RestoreConfigDialog username={username} run={restoringConfig} manifest={restoringConfig.manifest} onClose={() => setRestoringConfig(null)} />}
    </Card>
  );
}

function RestoreFilesDialog({ username, run, onClose }: { username: string; run: BackupRunDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<"folder" | "inplace">("folder");
  const restore = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${username}/backups/restore-files`, { snapshot: run.files, path: path.trim().replace(/^\/+|\/+$/g, ""), mode }));

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Restore files")}</DialogTitle>
          <DialogDescription>{t("From the backup of {{date}}. Files are written by the account user, as if uploaded over FTP.", { date: formatDateTime(run.time) })}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="restore-path">{t("Directory or file")}</Label>
          <Input id="restore-path" className="font-mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder={t("Empty: the whole home directory. For example: public_html/wp-content")} spellCheck={false} />
        </div>
        <RadioGroup value={mode} onValueChange={(value) => setMode(value as "folder" | "inplace")} className="grid gap-3">
          <label className="flex items-start gap-2 text-sm">
            <RadioGroupItem value="folder" className="mt-0.5" />
            <span><span className="font-medium">{t("In a new directory.")}</span> <span className="text-muted-foreground">{t("Restored into restored-<date>/, leaving current files untouched.")}</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <RadioGroupItem value="inplace" className="mt-0.5" />
            <span><span className="font-medium">{t("In place.")}</span> <span className="text-muted-foreground">{t("Replaces the files that are in the backup; files not in the backup are kept.")}</span></span>
          </label>
        </RadioGroup>
        <ActionFeedback action={restore} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Close")}</Button>
          <Button variant={mode === "inplace" ? "destructive" : "default"} disabled={restore.isPending} onClick={() => restore.mutate()}>{t("Restore")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PARTS = [
  { value: "options", label: "Environment options", hint: "Directory, PHP version and options, logs." },
  { value: "env", label: "App environment variables", hint: "Applied on the next deployment or restart." },
  { value: "app", label: "App configuration", hint: "Repository, branch and commands. Takes effect on the next deployment." },
] as const;

/** Picks which environments (among those that still exist) and which configuration parts to restore. */
function RestoreConfigDialog({ username, run, manifest, onClose }: { username: string; run: BackupRunDto; manifest: string; onClose: () => void }) {
  const { t } = useTranslation();
  const summary = useQuery({ queryKey: ["backup-manifest", username, manifest], queryFn: () => api.get<BackupManifestSummaryDto>(`/accounts/${username}/backups/manifest/${manifest}`) });
  const [fqdns, setFqdns] = useState<Set<string>>(new Set());
  const [parts, setParts] = useState<Set<string>>(new Set(["options", "env"]));
  const restore = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${username}/backups/restore-config`, { manifest, fqdns: [...fqdns], parts: [...parts] }));
  const toggle = (set: Set<string>, value: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  };
  const usable = summary.data?.vhosts.filter((vhost) => vhost.exists && vhost.sameType) ?? [];
  const missing = summary.data?.vhosts.filter((vhost) => !vhost.exists || !vhost.sameType) ?? [];

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Restore configuration")}</DialogTitle>
          <DialogDescription>{t("From the backup of {{date}}. Only for environments that still exist and are of the same type.", { date: formatDateTime(run.time) })}</DialogDescription>
        </DialogHeader>
        {summary.isError && <Alert variant="destructive"><AlertDescription>{summary.error.message}</AlertDescription></Alert>}
        {summary.isPending && <p className="text-sm text-muted-foreground">{t("Reading the backup…")}</p>}
        {summary.data && (
          <div className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label>{t("Environments")}</Label>
              {usable.length === 0 && <p className="text-sm text-muted-foreground">{t("None of the environments in the backup still exist in the account.")}</p>}
              {usable.map((vhost) => (
                <label key={vhost.fqdn} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={fqdns.has(vhost.fqdn)} onCheckedChange={(on) => setFqdns((current) => toggle(current, vhost.fqdn, on))} />
                  <span className="font-mono">{vhost.fqdn}</span>
                  <span className="text-muted-foreground">{vhost.type === "app" ? t("app · {{count}} variables", { count: vhost.envKeys.length }) : "PHP"}</span>
                </label>
              ))}
              {missing.length > 0 && <p className="text-xs text-muted-foreground">{t("Cannot be restored here: {{list}}.", { list: missing.map(({ fqdn }) => fqdn).join(", ") })}</p>}
            </div>
            <div className="grid gap-2">
              <Label>{t("What to restore")}</Label>
              {PARTS.map((part) => (
                <label key={part.value} className="flex items-start gap-2 text-sm">
                  <Checkbox className="mt-0.5" checked={parts.has(part.value)} onCheckedChange={(on) => setParts((current) => toggle(current, part.value, on))} />
                  <span><span className="font-medium">{t(part.label)}.</span> <span className="text-muted-foreground">{t(part.hint)}</span></span>
                </label>
              ))}
            </div>
          </div>
        )}
        <ActionFeedback action={restore} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Close")}</Button>
          <Button disabled={restore.isPending || fqdns.size === 0 || parts.size === 0} onClick={() => restore.mutate()}>{t("Restore")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A copy the account can take away: its home directory and one dump per database, with nothing from the panel. Works
 * for suspended accounts too, and even when S3 backups are not configured.
 */
export function AccountExportCard({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  const username = account.username;
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["exports", username],
    queryFn: () => api.get<AccountExportDto[]>(`/accounts/${username}/exports`),
    refetchInterval: (query) => (query.state.data?.some(({ status }) => status === "running") ? 3000 : false),
  });
  const create = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${username}/exports`));
  const [deleting, setDeleting] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["exports", username] });
  const current = list.data?.[0];

  async function remove(id: string) {
    setDeleting(true);
    try {
      await api.post(`/accounts/${username}/exports/${id}/delete`);
    } finally {
      setDeleting(false);
      refresh();
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Downloadable copy")}</CardTitle>
        <CardDescription>
          {t("A .tar.gz with the home directory and one .sql file per database, to hand the account its data. It contains nothing from the panel: no passwords, keys or server configuration. It is deleted after 24 hours.")}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" disabled={create.isPending || current?.status === "running"} onClick={() => create.mutate()}>
            <PackageIcon />{current ? t("Generate another") : t("Generate copy")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ActionFeedback action={create} onFinished={refresh} />
        {current?.status === "running" && <p className="text-sm text-muted-foreground">{t("Building the copy…")}</p>}
        {current?.status === "failed" && <Alert variant="destructive"><AlertDescription>{t("The last copy failed. Check the job in Jobs and generate it again.")}</AlertDescription></Alert>}
        {current?.status === "ready" && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button nativeButton={false} render={<a href={`/api/accounts/${username}/exports/${current.id}/download`} />} size="sm"><DownloadIcon />{t("Download ({{size}})", { size: current.sizeBytes !== null ? formatBytes(current.sizeBytes) : "—" })}</Button>
            <span className="text-muted-foreground">{t("Generated on {{created}} · expires on {{expires}}", { created: formatDateTime(current.createdAt), expires: formatDateTime(current.expiresAt) })}</span>
            <Button variant="ghost" size="sm" disabled={deleting} onClick={() => void remove(current.id)}><Trash2Icon />{t("Delete")}</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
