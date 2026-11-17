import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { JobCreatedDto, MigrationAccountDto } from "@eaglepanel/shared";
import { ArrowRightLeftIcon } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ActionFeedback, useJobAction } from "@/components/job-action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const EMPTY = { endpoint: "", bucket: "", prefix: "", region: "auto", accessKeyId: "", secretAccessKey: "", password: "" };

/**
 * Brings an account from another EaglePanel server, from its backup repository. The source repository credentials
 * are used only during the migration and are not stored.
 */
export function MigrationDialog() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState(EMPTY);
  const list = useMutation({ mutationFn: () => api.post<MigrationAccountDto[]>("/migrations/accounts", { source }) });
  const importAccount = useJobAction((input: { username: string; run: string }) => api.post<JobCreatedDto>("/migrations/import", { source, ...input }));
  const update = (key: keyof typeof EMPTY, value: string) => setSource((previous) => ({ ...previous, [key]: value.trim() }));
  const ready = Object.values(source).every(Boolean);

  function search(event: SyntheticEvent) {
    event.preventDefault();
    list.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setSource(EMPTY); list.reset(); } }}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}><ArrowRightLeftIcon />{t("Migrate from another server")}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Migrate an account from another server")}</DialogTitle>
          <DialogDescription>
            {t("Uses the other server's backup repository and its password. The account is recreated from the selected backup, including its FTP and MySQL passwords, and apps are deployed from Git. If the account or any of its domains already exists on this server, nothing is changed.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={search} className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2 sm:col-span-2">
            <Label htmlFor="mig-endpoint">Endpoint</Label>
            <Input id="mig-endpoint" value={source.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder="https://<account>.r2.cloudflarestorage.com" spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mig-bucket">Bucket</Label>
            <Input id="mig-bucket" value={source.bucket} onChange={(event) => update("bucket", event.target.value)} spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mig-prefix">{t("Source server prefix")}</Label>
            <Input id="mig-prefix" value={source.prefix} onChange={(event) => update("prefix", event.target.value)} spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mig-key">Access key ID</Label>
            <Input id="mig-key" value={source.accessKeyId} onChange={(event) => update("accessKeyId", event.target.value)} spellCheck={false} autoComplete="off" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mig-secret">Secret access key</Label>
            <Input id="mig-secret" type="password" value={source.secretAccessKey} onChange={(event) => update("secretAccessKey", event.target.value)} autoComplete="off" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mig-region">{t("Region")}</Label>
            <Input id="mig-region" value={source.region} onChange={(event) => update("region", event.target.value)} spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mig-password">{t("Repository password")}</Label>
            <Input id="mig-password" type="password" value={source.password} onChange={(event) => update("password", event.target.value)} autoComplete="off" />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" variant="outline" disabled={!ready || list.isPending}>{list.isPending ? t("Reading…") : t("Find accounts")}</Button>
          </div>
        </form>
        {list.isError && <Alert variant="destructive"><AlertDescription>{list.error.message}</AlertDescription></Alert>}
        {list.data?.length === 0 && <p className="text-sm text-muted-foreground">{t("That repository has no account backups.")}</p>}
        {list.data && list.data.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead>{t("Account")}</TableHead>
                  <TableHead>{t("Latest complete backup")}</TableHead>
                  <TableHead className="text-right">{t("Action")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.map((account) => {
                  const latest = account.runs.find((run) => run.complete);
                  return (
                    <TableRow key={account.username}>
                      <TableCell className="font-medium">{account.username}</TableCell>
                      <TableCell className="text-muted-foreground">{latest ? formatDateTime(latest.time) : t("None")}</TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          {account.exists
                            ? <Badge variant="outline">{t("Already exists here")}</Badge>
                            : <Button size="sm" disabled={!latest || importAccount.isPending} onClick={() => latest && importAccount.mutate({ username: account.username, run: latest.run })}>{t("Migrate")}</Button>}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <ActionFeedback action={importAccount} onFinished={() => void queryClient.invalidateQueries({ queryKey: ["accounts"] })} />
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>{t("Close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
