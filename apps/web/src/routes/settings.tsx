import { BackupSettingsCard } from "@/components/backups";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_DB_TUNING, dbTuningSchema, GLOBAL_HOOK_PATH, type DbTuning, type JobCreatedDto, type MeDto, type MysqlSettingsDto, type ServerSettingsDto, type WordPressSettingsDto } from "@eaglepanel/shared";
import { QRCodeSVG } from "qrcode.react";
import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { Page } from "@/components/app-shell";
import { ActionFeedback, useJobAction } from "@/components/job-action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ServerMailCard } from "@/components/server-mail";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";

function CodeInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <Input
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      required
      className="w-40"
    />
  );
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function EnableTotp() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");

  const setup = useMutation({ mutationFn: () => api.post<{ secret: string; uri: string }>("/auth/totp/setup") });
  const confirm = useMutation({
    mutationFn: () => api.post("/auth/totp/confirm", { code }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
    onError: () => setCode(""),
  });

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    confirm.mutate();
  }

  if (!setup.data) {
    return (
      <div className="flex flex-col items-start gap-4">
        {setup.isError && <ErrorAlert message={setup.error.message} />}
        <Button onClick={() => setup.mutate()} disabled={setup.isPending}>{t("Enable")}</Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6 sm:flex-row">
      <div className="w-fit shrink-0 rounded-lg bg-white p-3">
        <QRCodeSVG value={setup.data.uri} size={148} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="grid gap-1">
          <p className="text-sm text-muted-foreground">{t("Scan the code with your authenticator app, or enter this key:")}</p>
          <code className="text-sm break-all">{setup.data.secret}</code>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="totp-confirm">{t("Generated code")}</Label>
          <CodeInput id="totp-confirm" value={code} onChange={setCode} />
        </div>
        {confirm.isError && <ErrorAlert message={confirm.error.message} />}
        <div>
          <Button type="submit" disabled={confirm.isPending}>{t("Confirm")}</Button>
        </div>
      </div>
    </form>
  );
}

function DisableTotp() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  const disable = useMutation({
    mutationFn: () => api.post("/auth/totp/disable", { password, code }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
    onError: () => setCode(""),
  });

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    disable.mutate();
  }

  return (
    <form onSubmit={submit} className="flex max-w-xs flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor="totp-password">{t("Password")}</Label>
        <Input id="totp-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="totp-disable">{t("Current code")}</Label>
        <CodeInput id="totp-disable" value={code} onChange={setCode} />
      </div>
      {disable.isError && <ErrorAlert message={disable.error.message} />}
      <div>
        <Button type="submit" variant="destructive" disabled={disable.isPending}>{t("Disable")}</Button>
      </div>
    </form>
  );
}

/** One URL for the webhooks of every app on the server. The rest of the panel stays unpublished. */
function HooksDomainCard() {
  const current = useQuery({ queryKey: ["server-settings"], queryFn: () => api.get<ServerSettingsDto>("/settings/server") });
  if (!current.data) return null;
  return <HooksDomainForm key={current.data.hooksDomain ?? ""} saved={current.data.hooksDomain} />;
}

function HooksDomainForm({ saved }: { saved: string | null }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState(saved ?? "");
  const save = useJobAction((value: string | null) => api.post<JobCreatedDto>("/settings/server", { hooksDomain: value }));

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    save.mutate(domain.trim() || null);
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t("GitHub webhooks")}</CardTitle>
        <CardDescription>
          {t("A subdomain proxied by Cloudflare. If no account has a certificate that covers it, use Flexible SSL. OpenLiteSpeed publishes only the webhook path on it; the panel stays private. Each app has its own secret.")}
        </CardDescription>
        <CardAction><Badge variant="outline">{saved ? t("Active") : t("No domain")}</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="grid gap-2">
            <Label htmlFor="hooks-domain">{t("Domain")}</Label>
            <Input id="hooks-domain" value={domain} onChange={(event) => setDomain(event.target.value.trim().toLowerCase())} placeholder="hooks.example.com" spellCheck={false} className="w-72" />
          </div>
          <Button type="submit" variant="outline" disabled={save.isPending || (domain || null) === saved}>{domain ? t("Save") : t("Remove")}</Button>
        </form>
        {saved && <p className="text-sm text-muted-foreground">URL: <code>https://{saved}{GLOBAL_HOOK_PATH}</code></p>}
        <ActionFeedback action={save} onFinished={() => void queryClient.invalidateQueries({ queryKey: ["server-settings"] })} />
      </CardContent>
    </Card>
  );
}

/** performance_schema of MySQL or MariaDB: off by default; on only while a slow database is being looked into. */
function MysqlCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const current = useQuery({ queryKey: ["mysql-settings"], queryFn: () => api.get<MysqlSettingsDto>("/settings/mysql") });
  const change = useJobAction((enabled: boolean) => api.post<JobCreatedDto>("/settings/mysql", { performanceSchema: enabled }));
  const data = current.data;
  const on = data?.running ?? data?.configured ?? false;
  const engine = data?.engine === "mariadb" ? "MariaDB" : "MySQL";

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t("{{engine}} diagnostics", { engine })}</CardTitle>
        <CardDescription>
          {t("performance_schema records which queries run, how long they take and what they wait for. It reserves a few hundred MB of RAM, so it is off: turn it on to look into a slow database, and off again when done.")}
        </CardDescription>
        {data && <CardAction><Badge variant={on ? "default" : "outline"}>{data.running === null ? t("{{engine}} is not answering", { engine }) : on ? t("On") : t("Off")}</Badge></CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data?.memoryMb != null && <p className="text-sm text-muted-foreground">{t("{{engine}} uses {{mb}} MB of RAM now.", { engine, mb: data.memoryMb })}</p>}
        <div>
          <Button variant="outline" disabled={!data || data.running === null || change.isPending} onClick={() => change.mutate(!on)}>
            {on ? t("Turn off") : t("Turn on")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("Changing it restarts {{engine}}: sites are a few seconds without their databases.", { engine })}</p>
        <ActionFeedback action={change} onFinished={() => void queryClient.invalidateQueries({ queryKey: ["mysql-settings"] })} />
      </CardContent>
    </Card>
  );
}

type TuningField = Exclude<keyof DbTuning, "xProtocol">;
const TUNING_FIELDS: { key: TuningField; label: string; unit: string; hint: string }[] = [
  { key: "bufferPoolMb", label: "Buffer pool", unit: "MB", hint: "Cache of data and indexes. Enough when it holds the databases that are in use; more is RAM the sites lose." },
  { key: "logBufferMb", label: "Log buffer", unit: "MB", hint: "Writes waiting to reach the disk. A few MB are enough unless there are large imports." },
  { key: "maxConnections", label: "Connections", unit: "", hint: "At the same time, for every site together. Each one reserves memory while it is open." },
  { key: "tableOpenCache", label: "Open tables cache", unit: "", hint: "Tables kept open. Raise it if the server has many sites with many tables." },
  { key: "tableDefinitionCache", label: "Table definitions cache", unit: "", hint: "Table structures kept in memory. 400 is the minimum." },
];

const tuningForm = (tuning: DbTuning) => Object.fromEntries(TUNING_FIELDS.map(({ key }) => [key, String(tuning[key])])) as Record<TuningField, string>;

/** Memory settings of MySQL or MariaDB: small by default, raised here when the databases need it. */
function DatabaseMemoryCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const current = useQuery({ queryKey: ["mysql-settings"], queryFn: () => api.get<MysqlSettingsDto>("/settings/mysql") });
  const data = current.data;
  const saved = data?.tuning ?? null;
  const [form, setForm] = useState<Record<TuningField, string> | null>(null);
  const [xProtocol, setXProtocol] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = useJobAction((tuning: DbTuning) => api.post<JobCreatedDto>("/settings/mysql/tuning", { tuning }));
  const engine = data?.engine === "mariadb" ? "MariaDB" : "MySQL";
  const values = form ?? tuningForm(saved ?? DEFAULT_DB_TUNING);
  const x = xProtocol ?? saved?.xProtocol ?? DEFAULT_DB_TUNING.xProtocol;

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    const parsed = dbTuningSchema.safeParse({ ...Object.fromEntries(TUNING_FIELDS.map(({ key }) => [key, Number(values[key])])), xProtocol: data?.engine === "mysql" && x });
    if (!parsed.success) {
      setError(parsed.error.issues[0] ? `${t(TUNING_FIELDS.find(({ key }) => key === parsed.error.issues[0]!.path[0])?.label ?? "Value")}: ${t(parsed.error.issues[0].message)}` : t("Invalid data"));
      return;
    }
    setError(null);
    change.mutate(parsed.data);
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t("{{engine}} memory", { engine })}</CardTitle>
        <CardDescription>
          {t("Small values by default: the databases of a hosting server are usually small, and every MB reserved here is RAM the sites do not have. Raise them when the databases grow.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data && !saved && <p className="text-sm text-muted-foreground">{t("{{engine}} uses its own defaults now (no settings from the panel). Saving writes these values.", { engine })}</p>}
        {data?.ramMb != null && <p className="text-sm text-muted-foreground">{t("The server has {{mb}} MB of RAM.", { mb: data.ramMb })}</p>}
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {TUNING_FIELDS.map(({ key, label, unit, hint }) => (
              <div key={key} className="flex flex-col gap-1.5">
                <Label htmlFor={`tuning-${key}`}>{unit ? `${t(label)} (${unit})` : t(label)}</Label>
                <Input
                  id={`tuning-${key}`}
                  inputMode="numeric"
                  value={values[key]}
                  onChange={(event) => setForm({ ...values, [key]: event.target.value.replace(/\D/g, "") })}
                  className="w-40"
                />
                <p className="text-xs text-muted-foreground">
                  {t(hint)}
                  {data?.tuningRunning && ` ${t("Now: {{value}}.", { value: data.tuningRunning[key] })}`}
                </p>
              </div>
            ))}
          </div>
          {data?.engine === "mysql" && (
            <div className="flex items-start gap-3">
              <Switch id="tuning-x" checked={x} onCheckedChange={setXProtocol} />
              <div className="flex flex-col gap-1">
                <Label htmlFor="tuning-x">{t("X Protocol")}</Label>
                <p className="text-xs text-muted-foreground">{t("For MySQL Shell and the document store, on port 33060 (local only). PHP and WordPress do not use it.")}</p>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!data || data.running === null || change.isPending}>{t("Save and restart")}</Button>
            <Button type="button" variant="outline" onClick={() => { setForm(tuningForm(DEFAULT_DB_TUNING)); setXProtocol(DEFAULT_DB_TUNING.xProtocol); setError(null); }}>
              {t("Recommended values")}
            </Button>
          </div>
        </form>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <p className="text-sm text-muted-foreground">{t("Saving restarts {{engine}}: sites are a few seconds without their databases. If it does not start with the new values, the previous ones are put back.", { engine })}</p>
        <ActionFeedback
          action={change}
          onFinished={() => {
            setForm(null);
            setXProtocol(null);
            void queryClient.invalidateQueries({ queryKey: ["mysql-settings"] });
          }}
        />
      </CardContent>
    </Card>
  );
}

/** Wordfence Intelligence API key for the WordPress monitor. It is never sent back to the browser. */
function WordfenceCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const current = useQuery({ queryKey: ["wordpress-settings"], queryFn: () => api.get<WordPressSettingsDto>("/settings/wordpress") });
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (value: string | null) => api.post<WordPressSettingsDto>("/settings/wordpress", { wordfenceKey: value }),
    onSuccess: (data) => {
      setKey("");
      queryClient.setQueryData(["wordpress-settings"], data);
      void queryClient.invalidateQueries({ queryKey: ["wordpress"] });
    },
  });
  const configured = current.data?.wordfenceConfigured ?? false;

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (key.trim()) save.mutate(key.trim());
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t("WordPress vulnerabilities")}</CardTitle>
        <CardDescription>
          {t("The WordPress monitor looks up known vulnerabilities of core, plugins and themes in Wordfence Intelligence. Its feed is free, also for commercial use, but needs an API key: create a wordfence.com account and generate one under Integrations.")}
        </CardDescription>
        <CardAction><Badge variant="outline">{configured ? t("Active") : t("No API key")}</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="grid gap-2">
            <Label htmlFor="wordfence-key">{configured ? t("Replace API key") : t("API key")}</Label>
            <Input id="wordfence-key" type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} spellCheck={false} className="w-80" />
          </div>
          <Button type="submit" variant="outline" disabled={save.isPending || !key.trim()}>{t("Save")}</Button>
          {configured && (
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>{t("Remove")}</Button>
          )}
        </form>
        {save.isError && <ErrorAlert message={save.error.message} />}
        {save.isSuccess && (
          <p className="text-sm text-muted-foreground">
            {save.data.wordfenceConfigured ? t("Saved. The vulnerability database is being downloaded; it takes a minute.") : t("API key removed.")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const me = queryClient.getQueryData<MeDto>(["me"]);

  return (
    <Page>
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t("Two-factor authentication")}</CardTitle>
          <CardDescription>
            {t("Requires a one-time code at sign-in. If you lose access to the app, reset it on the server with admin:set.")}
          </CardDescription>
          <CardAction>
            <Badge variant="outline">{me?.totpEnabled ? t("Enabled") : t("Disabled")}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>{me?.totpEnabled ? <DisableTotp /> : <EnableTotp />}</CardContent>
      </Card>
      <ServerMailCard />
      <BackupSettingsCard />
      <HooksDomainCard />
      <WordfenceCard />
      <MysqlCard />
      <DatabaseMemoryCard />
    </Page>
  );
}
