import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_MAILBOX_QUOTA_MB, MAIL_INSTALL_COMMAND, type DnsRecordDto, type DnsRecordState, type ForwarderDto, type JobCreatedDto, type MailboxDto, type MailCertificateDto, type MailDomainDto, type MailImportScanDto } from "@eaglepanel/shared";
import { EllipsisVerticalIcon, RefreshCwIcon } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ActionFeedback, CopyField, SecretDialog, useJobAction } from "@/components/job-action";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";

const MB = 1024 * 1024;

/** One per line or separated by commas or spaces. */
const splitList = (text: string) => text.split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);

export const mailQueryKey = (username: string, zone: string) => ["mail", username, zone];

/** Mail of a domain: mailboxes, forwarders, catch-all and the DNS records it needs. */
export function MailSection({ username, zone }: { username: string; zone: string }) {
  const { t } = useTranslation();
  const mail = useQuery({
    queryKey: mailQueryKey(username, zone),
    queryFn: () => api.get<MailDomainDto>(`/accounts/${username}/domains/${zone}/mail`),
    // While the certificate is being requested on its own (not as a job), until it is there.
    refetchInterval: (query) => (query.state.data?.certificate.state === "pending" ? 5000 : false),
  });

  if (mail.isPending) return <Skeleton className="h-32 w-full" />;
  if (mail.isError) return <p className="text-sm text-destructive">{mail.error.message}</p>;
  const data = mail.data;
  const base = `/accounts/${username}/domains/${zone}/mail`;
  if (!data.enabled) return <EnableMailCard base={base} data={data} />;

  return (
    <>
      {data.serverError && (
        <Alert variant="destructive">
          <AlertTitle>{t("The mail server is not answering")}</AlertTitle>
          <AlertDescription>{data.serverError}</AlertDescription>
        </Alert>
      )}
      <MailboxesCard base={base} data={data} />
      <ForwardersCard base={base} data={data} />
      <DnsCard username={username} zone={zone} data={data} />
      <ClientSettingsCard base={base} data={data} />
      <CatchAllCard base={base} data={data} />
      <ImportCard username={username} zone={zone} base={base} data={data} />
      <DisableMailCard base={base} zone={zone} />
    </>
  );
}

function EnableMailCard({ base, data }: { base: string; data: MailDomainDto }) {
  const { t } = useTranslation();
  const enable = useJobAction(() => api.post<JobCreatedDto>(`${base}/enable`));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Mail")}</CardTitle>
        <CardDescription>
          {t("Mailboxes and forwarders for {{domain}}, on this server. Mail is received and sent through {{host}}; webmail, mta-sts, autoconfig and autodiscover are reserved too.", { domain: data.domain, host: data.mailHost })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data.available ? (
          <>
            <div>
              <Button disabled={enable.isPending} onClick={() => enable.mutate()}>{t("Enable mail")}</Button>
            </div>
            <ActionFeedback action={enable} />
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t("Mail is not installed on this server: it is optional. To install it, run this on the server:")}</p>
            <CopyField value={MAIL_INSTALL_COMMAND} mono />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function usage(box: MailboxDto): { text: string; full: boolean } {
  if (box.usedBytes === null) return { text: `— / ${formatBytes(box.quotaMb * MB)}`, full: false };
  return { text: `${formatBytes(box.usedBytes)} / ${formatBytes(box.quotaMb * MB)}`, full: box.usedBytes >= box.quotaMb * MB * 0.9 };
}

function MailboxesCard({ base, data }: { base: string; data: MailDomainDto }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [quota, setQuota] = useState(String(DEFAULT_MAILBOX_QUOTA_MB));
  const [editing, setEditing] = useState<MailboxDto | null>(null);
  const [deleting, setDeleting] = useState<MailboxDto | null>(null);
  const [secret, setSecret] = useState<{ address: string; password: string } | null>(null);
  const create = useJobAction((input: { name: string; quotaMb: number }) => api.post<JobCreatedDto>(`${base}/mailboxes`, input));
  const regenerate = useJobAction((box: string) => api.post<JobCreatedDto>(`${base}/mailboxes/${box}/password`));
  const remove = useJobAction((box: string) => api.post<JobCreatedDto>(`${base}/mailboxes/${box}/delete`));

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    create.mutate({ name: name.trim().toLowerCase(), quotaMb: Number(quota) });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Mailboxes")}</CardTitle>
        <CardDescription>{t("Each one has its own password and space. The password is generated by the panel and shown once.")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data.mailboxes.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead>{t("Address")}</TableHead>
                  <TableHead>{t("Used")}</TableHead>
                  <TableHead>{t("Aliases")}</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.mailboxes.map((box) => {
                  const used = usage(box);
                  return (
                    <TableRow key={box.address}>
                      <TableCell className="font-medium">{box.address}</TableCell>
                      <TableCell className={used.full ? "text-destructive" : undefined}>{used.text}</TableCell>
                      <TableCell className="max-w-64 truncate text-muted-foreground">{box.aliases.length > 0 ? box.aliases.map((alias) => `${alias}@${data.domain}`).join(", ") : "—"}</TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("Actions for {{name}}", { name: box.address })} />}>
                            <EllipsisVerticalIcon />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-48">
                            <DropdownMenuGroup>
                              <DropdownMenuItem onClick={() => setEditing(box)}>{t("Space and aliases")}</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => regenerate.mutate(box.name)}>{t("Regenerate password")}</DropdownMenuItem>
                            </DropdownMenuGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => setDeleting(box)}>{t("Delete")}</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-2">
            <Label htmlFor="mailbox-name">{t("New mailbox")}</Label>
            <div className="flex items-center gap-2">
              <Input id="mailbox-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="info" autoComplete="off" spellCheck={false} required />
              <span className="shrink-0 text-sm text-muted-foreground">@{data.domain}</span>
            </div>
          </div>
          <div className="grid gap-2 sm:w-36">
            <Label htmlFor="mailbox-quota">{t("Space (MB)")}</Label>
            <Input id="mailbox-quota" type="number" min={10} value={quota} onChange={(event) => setQuota(event.target.value)} required />
          </div>
          <Button type="submit" disabled={create.isPending}>{t("Create")}</Button>
        </form>
        <ActionFeedback
          action={create}
          onFinished={(ok) => {
            if (ok && create.data?.secret && create.variables) {
              setSecret({ address: `${create.variables.name}@${data.domain}`, password: create.data.secret });
              setName("");
            }
          }}
        />
        <ActionFeedback
          action={regenerate}
          onFinished={(ok) => { if (ok && regenerate.data?.secret && regenerate.variables) setSecret({ address: `${regenerate.variables}@${data.domain}`, password: regenerate.data.secret }); }}
        />
        <ActionFeedback action={remove} />
      </CardContent>
      <SecretDialog
        title={t("Password of {{address}}", { address: secret?.address ?? "" })}
        secret={secret?.password ?? null}
        onClose={() => setSecret(null)}
        description={t("The user is the full address. Save the password now: it will not be shown again.")}
      />
      {editing && <EditMailboxDialog base={base} domain={data.domain} box={editing} onClose={() => setEditing(null)} />}
      <AlertDialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete {{name}}?", { name: deleting?.address })}</AlertDialogTitle>
            <AlertDialogDescription>{t("Deletes the mailbox and all of its mail. This cannot be undone.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { if (deleting) remove.mutate(deleting.name); setDeleting(null); }}>{t("Delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function EditMailboxDialog({ base, domain, box, onClose }: { base: string; domain: string; box: MailboxDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [quota, setQuota] = useState(String(box.quotaMb));
  const [aliases, setAliases] = useState(box.aliases.join("\n"));
  const save = useJobAction(() => api.post<JobCreatedDto>(`${base}/mailboxes/${box.name}`, { quotaMb: Number(quota), aliases: splitList(aliases).map((alias) => alias.replace(`@${domain}`, "")) }));

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{box.address}</DialogTitle>
            <DialogDescription>{t("Aliases are other addresses of {{domain}} that deliver to this mailbox.", { domain })}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="edit-quota">{t("Space (MB)")}</Label>
            <Input id="edit-quota" type="number" min={10} value={quota} onChange={(event) => setQuota(event.target.value)} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="edit-aliases">{t("Aliases")}</Label>
            <Textarea id="edit-aliases" value={aliases} onChange={(event) => setAliases(event.target.value)} rows={4} spellCheck={false} placeholder={"ventas\ncontacto"} />
            <p className="text-sm text-muted-foreground">{t("One per line, only the part before @{{domain}}.", { domain })}</p>
          </div>
          <ActionFeedback action={save} onFinished={(ok) => ok && onClose()} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" disabled={save.isPending}>{t("Save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ForwardersCard({ base, data }: { base: string; data: MailDomainDto }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [recipients, setRecipients] = useState("");
  const [editing, setEditing] = useState<ForwarderDto | null>(null);
  const create = useJobAction(() => api.post<JobCreatedDto>(`${base}/forwarders`, { name: name.trim().toLowerCase(), recipients: splitList(recipients) }));
  const remove = useJobAction((forwarder: string) => api.post<JobCreatedDto>(`${base}/forwarders/${forwarder}/delete`));

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Forwarders")}</CardTitle>
        <CardDescription>{t("Addresses without a mailbox: what arrives is sent to other addresses, on this server or elsewhere. A domain can have only forwarders.")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data.forwarders.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead>{t("Address")}</TableHead>
                  <TableHead>{t("Sends to")}</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.forwarders.map((forwarder) => (
                  <TableRow key={forwarder.address}>
                    <TableCell className="font-medium">{forwarder.address}</TableCell>
                    <TableCell className="max-w-80 truncate text-muted-foreground">{forwarder.recipients.join(", ")}</TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("Actions for {{name}}", { name: forwarder.address })} />}>
                          <EllipsisVerticalIcon />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-40">
                          <DropdownMenuItem onClick={() => setEditing(forwarder)}>{t("Edit")}</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => remove.mutate(forwarder.name)}>{t("Delete")}</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="forwarder-name">{t("New forwarder")}</Label>
            <div className="flex items-center gap-2">
              <Input id="forwarder-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="contacto" autoComplete="off" spellCheck={false} required />
              <span className="shrink-0 text-sm text-muted-foreground">@{data.domain}</span>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="forwarder-recipients">{t("Sends to")}</Label>
            <Textarea id="forwarder-recipients" value={recipients} onChange={(event) => setRecipients(event.target.value)} rows={3} spellCheck={false} placeholder="someone@gmail.com" required />
            <p className="text-sm text-muted-foreground">{t("One address per line.")}</p>
          </div>
          <div>
            <Button type="submit" disabled={create.isPending}>{t("Create")}</Button>
          </div>
        </form>
        <ActionFeedback action={create} onFinished={(ok) => { if (ok) { setName(""); setRecipients(""); } }} />
        <ActionFeedback action={remove} />
        <Alert>
          <AlertDescription>{t("Forwarded mail keeps its original sender. Gmail and others accept it while the sender's DKIM signature is intact; messages that fail SPF and DMARC at arrival are rejected instead of forwarded.")}</AlertDescription>
        </Alert>
      </CardContent>
      {editing && <EditForwarderDialog base={base} forwarder={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function EditForwarderDialog({ base, forwarder, onClose }: { base: string; forwarder: ForwarderDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [recipients, setRecipients] = useState(forwarder.recipients.join("\n"));
  const save = useJobAction(() => api.post<JobCreatedDto>(`${base}/forwarders/${forwarder.name}`, { recipients: splitList(recipients) }));

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{forwarder.address}</DialogTitle>
            <DialogDescription>{t("One address per line.")}</DialogDescription>
          </DialogHeader>
          <Textarea value={recipients} onChange={(event) => setRecipients(event.target.value)} rows={5} spellCheck={false} aria-label={t("Sends to")} required />
          <ActionFeedback action={save} onFinished={(ok) => ok && onClose()} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" disabled={save.isPending}>{t("Save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RecordState({ state }: { state: DnsRecordState }) {
  const { t } = useTranslation();
  if (state === "ok") return <Badge variant="outline">{t("OK")}</Badge>;
  if (state === "missing") return <Badge variant="secondary">{t("Missing")}</Badge>;
  if (state === "different") return <Badge variant="destructive">{t("Different")}</Badge>;
  return <Badge variant="outline">{t("Unknown")}</Badge>;
}

function DnsCard({ username, zone, data }: { username: string; zone: string; data: MailDomainDto }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const pending = data.records.filter(({ state }) => state !== "ok").length;

  async function check() {
    setChecking(true);
    try {
      const fresh = await api.get<MailDomainDto>(`/accounts/${username}/domains/${zone}/mail?refresh=1`);
      queryClient.setQueryData(mailQueryKey(username, zone), fresh);
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DNS records")}</CardTitle>
        <CardDescription>
          {t("Add them where the domain's DNS is managed (Cloudflare, the registrar or any other). Changes can take a few minutes to show.")}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" disabled={checking} onClick={() => void check()}>
            <RefreshCwIcon className={checking ? "animate-spin" : undefined} />
            {t("Check again")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {pending === 0
          ? <p className="text-sm text-muted-foreground">{t("Everything is in place.")}</p>
          : <p className="text-sm text-muted-foreground">{t("{{count}} records missing or different.", { count: pending })}</p>}
        <div className="flex flex-col gap-3">
          {data.records.map((record) => <DnsRecordRow key={`${record.type} ${record.name} ${record.value}`} record={record} />)}
        </div>
        {data.checkedAt && <p className="text-xs text-muted-foreground">{t("Checked {{date}} against public DNS.", { date: formatDateTime(data.checkedAt) })}</p>}
      </CardContent>
    </Card>
  );
}

export function DnsRecordRow({ record }: { record: DnsRecordDto }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="font-mono">{record.type}</Badge>
        <span className="min-w-0 font-mono text-sm break-all">{record.name}</span>
        {record.priority !== undefined && <span className="text-sm text-muted-foreground">{t("priority {{value}}", { value: record.priority })}</span>}
        <span className="ml-auto"><RecordState state={record.state} /></span>
      </div>
      <CopyField value={record.value} mono />
      <p className="text-sm text-muted-foreground">
        {t(record.purpose)}
        {record.dnsOnly && `. ${t("In Cloudflare, DNS only (grey cloud): mail cannot go through the proxy.")}`}
      </p>
      {record.state === "different" && record.found.length > 0 && (
        <p className="text-sm text-destructive break-all">{t("Now: {{value}}", { value: record.found.join(" · ") })}</p>
      )}
    </div>
  );
}

export function CertificateState({ certificate, host }: { certificate: MailCertificateDto; host: string }) {
  const { t } = useTranslation();
  const { state, notAfter } = certificate;
  const until = notAfter ? formatDateTime(notAfter) : "";
  if (state === "valid") return <span>{t("Let's Encrypt, valid until {{date}}. It renews by itself.", { date: until })}</span>;
  if (state === "expiring") return <span>{t("Let's Encrypt, valid until {{date}}. It is renewed in the next hours.", { date: until })}</span>;
  if (state === "pending") return <span className="text-muted-foreground">{t("Requesting it from Let's Encrypt…")}</span>;
  if (state === "waiting") {
    return <span className="text-muted-foreground">{t("Not yet: it is requested by itself once {{host}} points to this server (its A record).", { host })}</span>;
  }
  return <span className="text-destructive">{t("It could not be obtained. The panel tries again by itself every few hours.")}</span>;
}

function ClientSettingsCard({ base, data }: { base: string; data: MailDomainDto }) {
  const { t } = useTranslation();
  const request = useJobAction(() => api.post<JobCreatedDto>(`${base}/certificate`));
  const { state, error } = data.certificate;
  const canRequest = state === "failed" || state === "expiring";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Mail client settings")}</CardTitle>
        <CardDescription>{t("For Outlook, Thunderbird, phones and the like. The user is the full address.")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">{t("Incoming (IMAP)")}</dt>
          <dd className="font-medium">{t("{{host}}, port 993, SSL/TLS", { host: data.mailHost })}</dd>
          <dt className="text-muted-foreground">{t("Outgoing (SMTP)")}</dt>
          <dd className="font-medium">{t("{{host}}, port 465 SSL/TLS, or 587 STARTTLS", { host: data.mailHost })}</dd>
          <dt className="text-muted-foreground">{t("Certificate")}</dt>
          <dd><CertificateState certificate={data.certificate} host={data.mailHost} /></dd>
          <dt className="text-muted-foreground">{t("Webmail")}</dt>
          <dd>
            {data.webmail.state === "ready" && (
              <a href={data.webmail.url} target="_blank" rel="noreferrer" className="font-medium underline-offset-4 hover:underline">{data.webmail.url}</a>
            )}
            {data.webmail.state === "no_certificate" && (
              <span className="text-muted-foreground">{t("Not published: the domain has no certificate that covers {{host}}.", { host: new URL(data.webmail.url).host })}</span>
            )}
            {data.webmail.state === "not_installed" && <span className="text-muted-foreground">{t("Not installed on this server.")}</span>}
          </dd>
        </dl>
        {data.webmail.state === "ready" && (
          <p className="text-sm text-muted-foreground">
            {t("For webmail, {{host}} has to point to this server in DNS (an A record, with or without the Cloudflare proxy). Users sign in with the full address or just the part before the @.", { host: new URL(data.webmail.url).host })}
          </p>
        )}
        {state !== "valid" && state !== "expiring" && (
          <p className="text-sm text-muted-foreground">{t("Until it has one, mail programs warn that the connection is not trusted.")}</p>
        )}
        {state === "failed" && error && (
          <Alert variant="destructive">
            <AlertTitle>{t("Let's Encrypt did not issue it")}</AlertTitle>
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        )}
        {canRequest && (
          <div>
            <Button variant="outline" onClick={() => request.mutate()} disabled={request.isPending}>{t("Request it now")}</Button>
          </div>
        )}
        <ActionFeedback action={request} />
      </CardContent>
    </Card>
  );
}

function CatchAllCard({ base, data }: { base: string; data: MailDomainDto }) {
  const { t } = useTranslation();
  const [address, setAddress] = useState(data.catchAll ?? "");
  const save = useJobAction((value: string | null) => api.post<JobCreatedDto>(`${base}/catch-all`, { address: value }));

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    save.mutate(address.trim() || null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Unknown addresses")}</CardTitle>
        <CardDescription>{t("Mail to an address of {{domain}} that does not exist is rejected. It can go to an address instead (catch-all), at the cost of receiving more spam.", { domain: data.domain })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-2">
            <Label htmlFor="catch-all">{t("Send them to")}</Label>
            <Input id="catch-all" type="email" value={address} onChange={(event) => setAddress(event.target.value)} placeholder={t("Empty: reject")} spellCheck={false} />
          </div>
          <Button type="submit" variant="outline" disabled={save.isPending || (address.trim() || null) === data.catchAll}>{t("Save")}</Button>
        </form>
        <ActionFeedback action={save} />
      </CardContent>
    </Card>
  );
}

/** Mail from the previous server: a cPanel backup uploaded to the account, or an IMAP copy of one mailbox. */
function ImportCard({ username, zone, base, data }: { username: string; zone: string; base: string; data: MailDomainDto }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Import mail")}</CardTitle>
        <CardDescription>{t("Bring the mail from the previous server. It can be run again: what is already here is not duplicated, so a last run after changing the MX brings what arrived in between.")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-8">
        <BackupImport username={username} zone={zone} base={base} />
        <ImapImport base={base} data={data} />
      </CardContent>
    </Card>
  );
}

function BackupImport({ username, zone, base }: { username: string; zone: string; base: string }) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const scanQuery = useQuery({
    queryKey: [...mailQueryKey(username, zone), "import"],
    queryFn: () => api.get<{ scan: MailImportScanDto | null }>(`${base}/import`),
  });
  const scanAction = useJobAction((value: string) => api.post<JobCreatedDto>(`${base}/import/scan`, { path: value }));
  const importAction = useJobAction((names: string[]) => api.post<JobCreatedDto>(`${base}/import/backup`, { mailboxes: names }));
  const discard = useJobAction(async () => ({ ...(await api.post<{ ok: true }>(`${base}/import/discard`)), jobId: null }));
  const scan = scanQuery.data?.scan ?? null;
  const chosen = scan ? scan.mailboxes.filter((box) => !skipped.has(box.name)).map((box) => box.name) : [];

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    setSkipped(new Set());
    scanAction.mutate(path.trim());
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-medium">{t("From a cPanel backup")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("Upload the full cPanel backup (backup-….tar.gz) to this account with the file manager or by FTP, or a folder with its mail, and give its path inside the account. Only the mail of {{domain}} is read from it. Mailboxes that do not exist here are created with the same password and quota they had in cPanel.", { domain: zone })}
      </p>
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="grid flex-1 gap-2">
          <Label htmlFor="import-path">{t("Path in the account")}</Label>
          <Input id="import-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="backup-11.24.2026_10-00-00_user.tar.gz" spellCheck={false} />
        </div>
        <Button type="submit" variant="outline" disabled={scanAction.isPending || path.trim() === ""}>{t("Look for mailboxes")}</Button>
      </form>
      <ActionFeedback action={scanAction} />

      {scan && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("Found in {{path}}:", { path: scan.path })}</p>
          {scan.mailboxes.length === 0 ? (
            <p className="text-sm">{t("No mailboxes of {{domain}} in that backup.", { domain: zone })}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>{t("Mailbox")}</TableHead>
                  <TableHead className="text-right">{t("Messages")}</TableHead>
                  <TableHead className="text-right">{t("Size")}</TableHead>
                  <TableHead>{t("Password")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scan.mailboxes.map((box) => (
                  <TableRow key={box.name}>
                    <TableCell>
                      <Checkbox
                        checked={!skipped.has(box.name)}
                        onCheckedChange={(on) => setSkipped((current) => {
                          const next = new Set(current);
                          if (on) next.delete(box.name);
                          else next.add(box.name);
                          return next;
                        })}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{box.name}@{zone}</TableCell>
                    <TableCell className="text-right tabular-nums">{box.messages}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(box.bytes)}</TableCell>
                    <TableCell>
                      {box.exists
                        ? <Badge variant="outline">{t("Already here: keeps its own")}</Badge>
                        : box.passwordHash
                          ? <Badge variant="secondary">{t("Same as in cPanel")}</Badge>
                          : <Badge variant="outline">{t("New: regenerate it after")}</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={importAction.isPending || chosen.length === 0} onClick={() => importAction.mutate(chosen)}>
              {t("Import {{count}} mailboxes", { count: chosen.length })}
            </Button>
            <Button variant="ghost" disabled={discard.isPending} onClick={() => discard.mutate()}>{t("Discard")}</Button>
          </div>
          <ActionFeedback action={importAction} />
          <ActionFeedback action={discard} />
        </div>
      )}
    </section>
  );
}

function ImapImport({ base, data }: { base: string; data: MailDomainDto }) {
  const { t } = useTranslation();
  const [mailbox, setMailbox] = useState(data.mailboxes[0]?.name ?? "");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [verify, setVerify] = useState(true);
  const copy = useJobAction((input: { name: string; host: string; port: number; user: string; password: string; verify: boolean }) => {
    const { name, ...source } = input;
    return api.post<JobCreatedDto>(`${base}/mailboxes/${name}/import`, source);
  });

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    copy.mutate({ name: mailbox, host: host.trim(), port: Number(port) || 993, user: user.trim(), password, verify });
    setPassword("");
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-medium">{t("From another server (IMAP)")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("Copies every folder of a mailbox of the previous server into one here, as long as it still answers. The password is used for the copy and is not stored.")}
      </p>
      {data.mailboxes.length === 0 ? (
        <p className="text-sm">{t("Create the mailbox here first.")}</p>
      ) : (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="imap-mailbox">{t("Into")}</Label>
            <select id="imap-mailbox" className="h-9 rounded-md border bg-transparent px-3 text-sm" value={mailbox} onChange={(event) => setMailbox(event.target.value)}>
              {data.mailboxes.map((box) => <option key={box.name} value={box.name}>{box.address}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <div className="grid gap-2">
              <Label htmlFor="imap-host">{t("Server")}</Label>
              <Input id="imap-host" value={host} onChange={(event) => setHost(event.target.value)} placeholder="mail.oldserver.com" spellCheck={false} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="imap-port">{t("Port")}</Label>
              <Input id="imap-port" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="imap-user">{t("User")}</Label>
            <Input id="imap-user" value={user} onChange={(event) => setUser(event.target.value)} placeholder="name@domain.com" spellCheck={false} autoComplete="off" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="imap-password">{t("Password")}</Label>
            <Input id="imap-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Checkbox checked={verify} onCheckedChange={(on) => setVerify(on === true)} />
            {t("Check the server certificate (turn it off only for an IP or a self-signed certificate)")}
          </label>
          <div className="sm:col-span-2">
            <Button type="submit" variant="outline" disabled={copy.isPending || !mailbox || !host.trim() || !user.trim() || !password}>{t("Copy")}</Button>
          </div>
        </form>
      )}
      <ActionFeedback action={copy} />
    </section>
  );
}

function DisableMailCard({ base, zone }: { base: string; zone: string }) {
  const { t } = useTranslation();
  const disable = useJobAction(() => api.post<JobCreatedDto>(`${base}/disable`));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Disable mail")}</CardTitle>
        <CardDescription>{t("Deletes every mailbox of {{domain}} with its mail, and its forwarders.", { domain: zone })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive" disabled={disable.isPending} />}>{t("Disable mail")}</AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("Disable mail on {{domain}}?", { domain: zone })}</AlertDialogTitle>
                <AlertDialogDescription>{t("Deletes every mailbox of {{domain}} with its mail, and its forwarders.", { domain: zone })} {t("This cannot be undone.")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => disable.mutate()}>{t("Disable mail")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <ActionFeedback action={disable} />
      </CardContent>
    </Card>
  );
}
