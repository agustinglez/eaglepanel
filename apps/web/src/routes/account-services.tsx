import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { AccountDto, AccountService, JobCreatedDto, VhostDto } from "@eaglepanel/shared";
import { CirclePlusIcon, EllipsisVerticalIcon } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ActionFeedback, CopyField, SecretDialog, useJobAction } from "@/components/job-action";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";

const MB = 1024 * 1024;
const WARNING_RATIO = 0.9;

export function DatabasesTab({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  const base = `/accounts/${account.username}/databases`;
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [credentials, setCredentials] = useState<{ database: string; password: string; created: boolean } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const create = useJobAction((database: string) => api.post<JobCreatedDto>(base, { name: database }));
  const regenerate = useJobAction((database: string) => api.post<JobCreatedDto>(`${base}/${database}/password`));
  const optimize = useJobAction((database: string) => api.post<JobCreatedDto>(`${base}/${database}/optimize`));
  const remove = useJobAction((database: string) => api.post<JobCreatedDto>(`${base}/${database}/delete`));

  const usedBytes = account.databases.reduce((total, database) => total + database.sizeBytes, 0);
  const limitBytes = account.limits.dbStorageMb * MB;
  const ratio = limitBytes > 0 ? usedBytes / limitBytes : 0;
  const atLimit = account.databases.length >= account.limits.databases;

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    setOpen(false);
    create.mutate(name);
  }

  return (
    <div className="flex flex-col gap-4">
      {account.dbBlocked && (
        <Alert variant="destructive">
          <AlertTitle>{t("Writes blocked")}</AlertTitle>
          <AlertDescription>{t("The account exceeded its limit or the server is low on disk space. Reads and deletes are still allowed. After deleting data, optimize the database to free space.")}</AlertDescription>
        </Alert>
      )}
      {!account.dbBlocked && ratio >= WARNING_RATIO && (
        <Alert>
          <AlertTitle>{t("Close to the limit")}</AlertTitle>
          <AlertDescription>{t("At {{limit}}, writes are blocked on every database in the account.", { limit: formatBytes(limitBytes) })}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t("Databases")}</CardTitle>
          <CardDescription>{t("{{used}} of {{limit}} databases. Each user has privileges only on its own database.", { used: account.databases.length, limit: account.limits.databases })}</CardDescription>
          <CardAction>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger render={<Button size="sm" disabled={atLimit || account.dbBlocked || account.suspended} />}><CirclePlusIcon />{t("New database")}</DialogTrigger>
              <DialogContent>
                <form onSubmit={submit} className="grid gap-4">
                  <DialogHeader>
                    <DialogTitle>{t("New database")}</DialogTitle>
                    <DialogDescription>{t("Creates the database and a user with the same name. The password is generated and shown only once.")}</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-2">
                    <Label htmlFor="db-name">{t("Name")}</Label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">{account.username}_</span>
                      <Input id="db-name" value={name} maxLength={15} onChange={(event) => setName(event.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""))} placeholder="shop" autoComplete="off" spellCheck={false} required />
                    </div>
                  </div>
                  <DialogFooter><Button type="submit">{t("Create database")}</Button></DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
              <span className="text-muted-foreground">{t("Total size")}</span>
              <span className={ratio >= WARNING_RATIO ? "font-medium text-destructive tabular-nums" : "tabular-nums"}>{t("{{used}} of {{limit}}", { used: formatBytes(usedBytes), limit: formatBytes(limitBytes) })}</span>
            </div>
            <Progress value={Math.min(100, ratio * 100)} />
          </div>
          {account.databases.length === 0
            ? <p className="text-sm text-muted-foreground">{t("No databases yet.")}</p>
            : (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader className="bg-muted">
                    <TableRow>
                      <TableHead>{t("Database")}</TableHead>
                      <TableHead>{t("User")}</TableHead>
                      <TableHead>{t("Size")}</TableHead>
                      <TableHead>{t("Writes")}</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {account.databases.map((database) => (
                      <TableRow key={database.name}>
                        <TableCell className="font-medium">
                          <Link to="/accounts/$username/databases/$database" params={{ username: account.username, database: database.name }} search={{}} className="hover:underline">{database.name}</Link>
                        </TableCell>
                        {/* The panel creates one user per database, with the same name. */}
                        <TableCell>{database.name}</TableCell>
                        <TableCell className="tabular-nums">{formatBytes(database.sizeBytes)}</TableCell>
                        <TableCell>{account.dbBlocked ? <Badge variant="destructive">{t("Blocked")}</Badge> : <Badge variant="outline">{t("Allowed")}</Badge>}</TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("Actions for {{name}}", { name: database.name })} />}>
                              <EllipsisVerticalIcon />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-48">
                              <DropdownMenuGroup>
                                <DropdownMenuItem render={<Link to="/accounts/$username/databases/$database" params={{ username: account.username, database: database.name }} search={{}} />}>{t("Open")}</DropdownMenuItem>
                                <DropdownMenuItem render={<a href={`/api/accounts/${account.username}/databases/${database.name}/export`} download />}>{t("Export")}</DropdownMenuItem>
                              </DropdownMenuGroup>
                              <DropdownMenuSeparator />
                              <DropdownMenuGroup>
                                <DropdownMenuItem onClick={() => regenerate.mutate(database.name)}>{t("Regenerate password")}</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => optimize.mutate(database.name)}>{t("Optimize")}</DropdownMenuItem>
                              </DropdownMenuGroup>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(database.name)}>{t("Delete")}</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          <ActionFeedback
            action={create}
            onFinished={(ok) => {
              if (ok && create.data?.secret && create.variables) {
                setCredentials({ database: `${account.username}_${create.variables}`, password: create.data.secret, created: true });
                setName("");
              }
            }}
          />
          <ActionFeedback
            action={regenerate}
            onFinished={(ok) => {
              if (ok && regenerate.data?.secret && regenerate.variables) setCredentials({ database: regenerate.variables, password: regenerate.data.secret, created: false });
            }}
          />
          <ActionFeedback action={optimize} />
          <ActionFeedback action={remove} />
        </CardContent>
      </Card>
      <ConnectionDialog credentials={credentials} onClose={() => setCredentials(null)} />
      <AlertDialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete {{name}}?", { name: deleting })}</AlertDialogTitle>
            <AlertDialogDescription>{t("Deletes the database, its user and all of its data. This cannot be undone.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { if (deleting) remove.mutate(deleting); setDeleting(null); }}>{t("Delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** MySQL socket inside each app container: apps cannot reach MySQL over TCP. */
const MYSQL_SOCKET = "/run/mysqld/mysqld.sock";

/** Everything needed to connect; the password is shown only once. */
function ConnectionDialog({ credentials, onClose }: { credentials: { database: string; password: string; created: boolean } | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={credentials !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{credentials?.created ? t("Database created") : t("New password")}</DialogTitle>
          <DialogDescription>{t("Save the password now. It will not be shown again. If you lose it, you can regenerate it.")}</DialogDescription>
        </DialogHeader>
        {credentials && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><Label>{t("Database")}</Label><CopyField value={credentials.database} mono /></div>
            <div className="grid gap-2"><Label>{t("User")}</Label><CopyField value={credentials.database} mono /></div>
            <div className="grid gap-2 sm:col-span-2"><Label>{t("Password")}</Label><CopyField value={credentials.password} mono /></div>
            <div className="grid gap-2"><Label>Host (PHP)</Label><CopyField value="localhost" mono /></div>
            <div className="grid gap-2"><Label>{t("Port")}</Label><CopyField value="3306" mono /></div>
            <div className="grid gap-2 sm:col-span-2"><Label>Socket (apps)</Label><CopyField value={MYSQL_SOCKET} mono /></div>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          {t("PHP sites connect to localhost. Apps (Node or Bun) can only connect through the socket: TCP connections from their container are not available.")}
        </p>
        <DialogFooter><Button onClick={onClose}>{t("I saved it")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FtpTab({ account }: { account: AccountDto }) {
  return (
    <div className="flex flex-col gap-4">
      <AccountFtpCard account={account} />
      <SiteFtpList account={account} />
    </div>
  );
}

function AccountFtpCard({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState<string | null>(null);
  const server = useQuery({ queryKey: ["server-ip"], queryFn: () => api.get<{ ip: string | null }>("/server-ip") });
  const regenerate = useJobAction(() => api.post<JobCreatedDto>(`/accounts/${account.username}/ftp/password`));

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>{t("General FTP account")}</CardTitle>
        <CardDescription>{t("Sees the whole home directory, with every environment. Requires an encrypted connection (FTPS).")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2"><Label>{t("Server")}</Label><CopyField value={server.data?.ip ?? t("Server IP")} /></div>
          <div className="grid gap-2"><Label>{t("Port")}</Label><CopyField value="21" /></div>
          <div className="grid gap-2"><Label>{t("User")}</Label><CopyField value={account.username} /></div>
          <div className="grid gap-2"><Label>{t("Root directory")}</Label><Input readOnly value={`/home/${account.username}`} /></div>
        </div>
        <p className="text-sm text-muted-foreground">
          {account.ftpPasswordChangedAt ? t("Password changed on {{date}}.", { date: formatDateTime(account.ftpPasswordChangedAt) }) : t("No password set yet.")} {t("Connect directly to the IP address: FTP traffic does not go through Cloudflare.")}
        </p>
        <div>
          <Button variant="outline" disabled={regenerate.isPending} onClick={() => regenerate.mutate()}>{account.ftpPasswordChangedAt ? t("Regenerate password") : t("Generate password")}</Button>
        </div>
        <ActionFeedback action={regenerate} onFinished={(ok) => { if (ok) setSecret(regenerate.data?.secret ?? null); }} />
      </CardContent>
      <SecretDialog title={t("FTP password")} secret={secret} onClose={() => setSecret(null)} />
    </Card>
  );
}

function SiteFtpList({ account }: { account: AccountDto }) {
  const { t } = useTranslation();
  // Apps have no files to upload: they have no FTP access of their own.
  const sites = account.vhosts.flatMap((vhost) => (vhost.ftp ? [{ id: vhost.id, name: vhost.name, ftp: vhost.ftp }] : []));
  if (sites.length === 0) return null;
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>{t("Environment FTP accounts")}</CardTitle>
        <CardDescription>{t("Each environment can have its own access, which only sees its directory. It is created from the environment page.")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead>{t("User")}</TableHead>
                <TableHead>{t("Root directory")}</TableHead>
                <TableHead className="text-right">{t("Status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sites.map((vhost) => (
                <TableRow key={vhost.id}>
                  <TableCell className="font-medium">
                    <Link to="/accounts/$username/environments/$id" params={{ username: account.username, id: String(vhost.id) }} search={{ tab: "ftp" }} className="hover:underline">{vhost.ftp.login}</Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{vhost.ftp.root}</TableCell>
                  <TableCell className="text-right">
                    {vhost.ftp.passwordChangedAt ? <Badge variant="outline">{t("Active")}</Badge> : <Badge variant="secondary">{t("No access")}</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/** FTP access of a single environment: vsftpd locks it inside `sites/<slug>`. */
export function SiteFtpCard({ username, vhost, ftp, suspended }: { username: string; vhost: VhostDto; ftp: NonNullable<VhostDto["ftp"]>; suspended: boolean }) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState<string | null>(null);
  const server = useQuery({ queryKey: ["server-ip"], queryFn: () => api.get<{ ip: string | null }>("/server-ip") });
  const regenerate = useJobAction(() => api.post<JobCreatedDto>(`/vhosts/${vhost.id}/ftp/password`));
  const remove = useJobAction(() => api.post<JobCreatedDto>(`/vhosts/${vhost.id}/ftp/delete`));
  const active = ftp.passwordChangedAt !== null;

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>{t("Environment FTP account")}</CardTitle>
        <CardDescription>{t("Only sees the directory of this environment. The general FTP account of {{username}} keeps seeing everything. Requires an encrypted connection (FTPS).", { username })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2"><Label>{t("Server")}</Label><CopyField value={server.data?.ip ?? t("Server IP")} /></div>
          <div className="grid gap-2"><Label>{t("Port")}</Label><CopyField value="21" /></div>
          <div className="grid gap-2"><Label>{t("User")}</Label><CopyField value={ftp.login} /></div>
          <div className="grid gap-2"><Label>{t("Root directory")}</Label><Input readOnly value={`/home/${username}/${ftp.root}`} /></div>
        </div>
        <p className="text-sm text-muted-foreground">
          {active ? t("Password changed on {{date}}.", { date: formatDateTime(ftp.passwordChangedAt ?? 0) }) : t("This environment has no FTP access of its own yet.")}
          {suspended && ` ${t("The account is suspended: FTP is blocked.")}`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={regenerate.isPending} onClick={() => regenerate.mutate()}>{active ? t("Regenerate password") : t("Create access")}</Button>
          {active && (
            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="ghost" disabled={remove.isPending} />}>{t("Remove access")}</AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("Remove the FTP access of {{name}}?", { name: vhost.name })}</AlertDialogTitle>
                  <AlertDialogDescription>{t("New logins are rejected. The files stay where they are.")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>{t("Remove access")}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        <ActionFeedback action={regenerate} onFinished={(ok) => { if (ok) setSecret(regenerate.data?.secret ?? null); }} />
        <ActionFeedback action={remove} />
      </CardContent>
      <SecretDialog title={t("FTP password of {{name}}", { name: vhost.name })} secret={secret} onClose={() => setSecret(null)} />
    </Card>
  );
}

function ServiceCard({ account, name, title }: { account: AccountDto; name: AccountService; title: string }) {
  const { t } = useTranslation();
  const service = account.services[name];
  const [memory, setMemory] = useState(String(service.memoryMb));
  const save = useJobAction((input: { enabled: boolean; memoryMb: number }) => api.post<JobCreatedDto>(`/accounts/${account.username}/services/${name}`, input));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{t("Dedicated instance for the account, with a private socket.")}</CardDescription>
        <CardAction>
          <Switch aria-label={t("Enable {{name}}", { name: title })} checked={service.enabled} disabled={save.isPending || account.suspended} onCheckedChange={(enabled) => save.mutate({ enabled, memoryMb: Number(memory) })} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor={`${name}-memory`}>{t("Maximum memory (MB)")}</Label>
          <div className="flex gap-2">
            <Input id={`${name}-memory`} type="number" min="8" max="4096" value={memory} onChange={(event) => setMemory(event.target.value)} className="w-28" />
            <Button variant="outline" disabled={save.isPending || account.suspended || Number(memory) === service.memoryMb} onClick={() => save.mutate({ enabled: service.enabled, memoryMb: Number(memory) })}>{t("Save")}</Button>
          </div>
        </div>
        <div className="grid gap-2"><Label>Socket</Label><CopyField value={service.socket} mono /></div>
        <ActionFeedback action={save} />
      </CardContent>
    </Card>
  );
}

export function ServicesTab({ account }: { account: AccountDto }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ServiceCard account={account} name="redis" title="Redis" />
      <ServiceCard account={account} name="memcached" title="Memcached" />
    </div>
  );
}
