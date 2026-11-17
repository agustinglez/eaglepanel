import { MigrationDialog } from "@/components/migration";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { AccountDto, PreflightDto } from "@eaglepanel/shared";
import { CirclePlusIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Page } from "@/components/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { serverText } from "@/lib/i18n";

export function usePhpVersions() {
  return useQuery({
    queryKey: ["php-versions"],
    queryFn: () => api.get<{ versions: string[] }>("/php-versions"),
    staleTime: 60_000,
  });
}

const formatPhp = (version: string) => `PHP ${version[0]}.${version.slice(1)}`;

export function PhpSelect({ id, value, onChange, disabled }: { id?: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const versions = usePhpVersions();
  const items = (versions.data?.versions ?? [value]).filter(Boolean).map((version) => ({ value: version, label: formatPhp(version) }));

  return (
    <Select items={items} value={value} onValueChange={(next) => next && next !== value && onChange(next)} disabled={disabled}>
      <SelectTrigger id={id} className="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="min-w-0">
        <SelectGroup>
          {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function PreflightWarning() {
  const { t } = useTranslation();
  const preflight = useQuery({ queryKey: ["preflight"], queryFn: () => api.get<PreflightDto>("/system/preflight"), retry: false });
  const failed = preflight.data?.checks.filter((check) => !check.ok) ?? [];
  if (failed.length === 0) return null;

  return (
    <Alert variant="destructive">
      <AlertTitle>{t("The server is not ready to create accounts")}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {failed.map((check) => <li key={check.name}>{serverText(check.name)}: {serverText(check.detail)}</li>)}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

export function AccountsPage() {
  const { t } = useTranslation();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<AccountDto[]>("/accounts") });

  return (
    <Page>
      <PreflightWarning />
      <Card>
        <CardHeader>
          <CardTitle>{t("Hosting accounts")}</CardTitle>
          <CardDescription>{t("Each account has its own user, home directory, environments and limits.")}</CardDescription>
          <CardAction className="flex gap-2">
            <MigrationDialog />
            <Button size="sm" nativeButton={false} render={<Link to="/accounts/new" />}>
              <CirclePlusIcon />
              {t("New account")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {accounts.isPending && <Skeleton className="h-24 w-full" />}
          {accounts.isError && <p className="text-sm text-destructive">{accounts.error.message}</p>}
          {accounts.data?.length === 0 && <p className="text-sm text-muted-foreground">{t("No accounts yet.")}</p>}
          {accounts.data && accounts.data.length > 0 && (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader className="bg-muted">
                  <TableRow>
                    <TableHead>{t("Username")}</TableHead>
                    <TableHead>{t("Domain")}</TableHead>
                    <TableHead>{t("Additional environments")}</TableHead>
                    <TableHead>{t("Disk")}</TableHead>
                    <TableHead>HTTPS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.data.map((account) => (
                    <TableRow key={account.username}>
                      <TableCell>
                        <Button variant="link" className="h-auto p-0 text-foreground" nativeButton={false} render={<Link to="/accounts/$username" params={{ username: account.username }} />}>
                          {account.username}
                        </Button>
                        {account.suspended && <Badge variant="destructive" className="ml-2">{t("Suspended")}</Badge>}
                      </TableCell>
                      <TableCell>{account.domains.join(", ")}</TableCell>
                      <TableCell className="text-muted-foreground">{t("{{used}} of {{limit}}", { used: account.vhosts.filter(({ isMain }) => !isMain).length, limit: account.limits.vhosts })}</TableCell>
                      <TableCell>{formatBytes(account.limits.quotaMb * 1024 * 1024)}</TableCell>
                      <TableCell>
                        {account.vhosts.every(({ certZone }) => certZone) ? <Badge variant="outline">{t("Active")}</Badge> : <Badge variant="destructive">{t("No certificate")}</Badge>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
