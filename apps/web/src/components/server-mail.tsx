import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MAIL_INSTALL_COMMAND, type JobCreatedDto, type ServerMailDto } from "@eaglepanel/shared";
import { RefreshCwIcon } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ActionFeedback, CopyField, useJobAction } from "@/components/job-action";
import { CertificateState, DnsRecordRow, RecordState } from "@/components/mail";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const QUERY_KEY = ["mail", "server"];

/**
 * Settings › Server mail: the name the server delivers with (EHLO), what it needs in DNS and at the provider (PTR),
 * whether port 25 goes out, and its certificate. It is the server's, not an account's.
 */
export function ServerMailCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<ServerMailDto>("/settings/mail"),
    refetchInterval: (current) => (current.state.data?.certificate.state === "pending" ? 5000 : false),
  });
  const request = useJobAction(() => api.post<JobCreatedDto>("/settings/mail/certificate"));

  async function check() {
    setChecking(true);
    try {
      queryClient.setQueryData(QUERY_KEY, await api.get<ServerMailDto>("/settings/mail?refresh=1"));
    } finally {
      setChecking(false);
    }
  }

  const data = query.data;
  const ready = data?.running && data.named;
  const pending = data ? data.records.filter(({ state }) => state !== "ok").length + data.ptrs.filter(({ state }) => state !== "ok").length : 0;

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t("Server mail")}</CardTitle>
        <CardDescription>
          {t("The name this server uses to deliver mail for every domain. Other servers check it before accepting mail: without these records, it may end up as spam.")}
        </CardDescription>
        {ready && (
          <CardAction>
            <Button variant="outline" size="sm" disabled={checking} onClick={() => void check()}>
              <RefreshCwIcon className={checking ? "animate-spin" : undefined} />
              {t("Check again")}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {query.isPending && <Skeleton className="h-24 w-full" />}
        {query.isError && <p className="text-sm text-destructive">{query.error.message}</p>}
        {data && !data.installed && (
          <>
            <p className="text-sm text-muted-foreground">{t("Mail is not installed on this server: it is optional. To install it, run this on the server:")}</p>
            <CopyField value={MAIL_INSTALL_COMMAND} mono />
          </>
        )}
        {data && data.installed && !data.running && (
          <Alert variant="destructive">
            <AlertTitle>{t("The mail server is not answering")}</AlertTitle>
            <AlertDescription>{t("Check it on the server with journalctl -u stalwart.")}</AlertDescription>
          </Alert>
        )}
        {data?.running && !data.named && (
          <Alert>
            <AlertTitle>{t("The server has no mail name yet")}</AlertTitle>
            <AlertDescription>
              {t("It greets other servers as {{name}}, which no one accepts. Give it a name of a domain of yours, like mail.yourdomain.com.", { name: data.hostname })}
            </AlertDescription>
          </Alert>
        )}
        {data?.running && <HostnameForm current={data.named ? data.hostname : null} />}
        {data && ready && (
          <>
            <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted-foreground">{t("Address")}</dt>
              <dd className="font-mono break-all">{data.ip ?? t("Unknown")}</dd>
              <dt className="text-muted-foreground">{t("Outgoing port 25")}</dt>
              <dd><Port25 state={data.port25} /></dd>
              <dt className="text-muted-foreground">{t("Certificate")}</dt>
              <dd><CertificateState certificate={data.certificate} host={data.hostname!} /></dd>
            </dl>
            {data.port25 === "blocked" && (
              <Alert variant="destructive">
                <AlertTitle>{t("The provider blocks outgoing port 25")}</AlertTitle>
                <AlertDescription>
                  {t("Mail can be received, but not delivered to other servers. Ask the provider to open it (many do it on request), or use a relay.")}
                </AlertDescription>
              </Alert>
            )}
            {data.certificate.state === "failed" && data.certificate.error && (
              <Alert variant="destructive">
                <AlertTitle>{t("Let's Encrypt did not issue it")}</AlertTitle>
                <AlertDescription className="break-words">{data.certificate.error}</AlertDescription>
              </Alert>
            )}
            {(data.certificate.state === "failed" || data.certificate.state === "expiring") && (
              <div>
                <Button variant="outline" onClick={() => request.mutate()} disabled={request.isPending}>{t("Request it now")}</Button>
              </div>
            )}
            <ActionFeedback action={request} />

            {pending === 0
              ? <p className="text-sm text-muted-foreground">{t("Everything is in place.")}</p>
              : <p className="text-sm text-muted-foreground">{t("{{count}} records missing or different.", { count: pending })}</p>}
            <div className="flex flex-col gap-3">
              {data.records.map((record) => <DnsRecordRow key={`${record.type} ${record.name}`} record={record} />)}
              {data.ptrs.map((ptr) => <PtrRow key={ptr.ip} hostname={data.hostname!} ptr={ptr} />)}
            </div>
            {data.checkedAt && <p className="text-xs text-muted-foreground">{t("Checked {{date}} against public DNS.", { date: formatDateTime(data.checkedAt) })}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function HostnameForm({ current }: { current: string | null }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(current ?? "");
  const save = useJobAction((hostname: string) => api.post<JobCreatedDto>("/settings/mail/hostname", { hostname }));
  const next = value.trim().toLowerCase();

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    save.mutate(next);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="grid flex-1 gap-2">
          <Label htmlFor="mail-hostname">{t("Name")}</Label>
          <Input id="mail-hostname" value={value} onChange={(event) => setValue(event.target.value)} placeholder="mail.yourdomain.com" spellCheck={false} autoCapitalize="none" />
        </div>
        <Button type="submit" variant="outline" disabled={save.isPending || next === "" || next === current}>{t("Save")}</Button>
      </div>
      {current && next !== current && next !== "" && (
        <p className="text-sm text-muted-foreground">{t("Its records and its certificate change with it: they are shown again for the new name.")}</p>
      )}
      <ActionFeedback action={save} />
    </form>
  );
}

function Port25({ state }: { state: ServerMailDto["port25"] }) {
  const { t } = useTranslation();
  if (state === "open") return <Badge variant="outline">{t("Open")}</Badge>;
  if (state === "blocked") return <Badge variant="destructive">{t("Blocked")}</Badge>;
  return <Badge variant="outline">{t("Unknown")}</Badge>;
}

/** The reverse DNS is not set in the domain DNS but at the provider of the server (or its IP). */
function PtrRow({ hostname, ptr }: { hostname: string; ptr: ServerMailDto["ptrs"][number] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="font-mono">PTR</Badge>
        <span className="min-w-0 font-mono text-sm break-all">{ptr.ip}</span>
        <span className="ml-auto"><RecordState state={ptr.state} /></span>
      </div>
      <CopyField value={hostname} mono />
      <p className="text-sm text-muted-foreground">
        {t("Reverse DNS: the address has to resolve back to the server name. It is set at the server provider (often called rDNS or PTR), not in the domain DNS.")}
      </p>
      {ptr.state === "different" && ptr.found.length > 0 && (
        <p className="text-sm text-destructive break-all">{t("Now: {{value}}", { value: ptr.found.join(" · ") })}</p>
      )}
    </div>
  );
}
