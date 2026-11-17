import { useQuery } from "@tanstack/react-query";
import type { AuditEntryDto } from "@eaglepanel/shared";
import { useTranslation } from "react-i18next";
import { Page } from "@/components/app-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { serverText } from "@/lib/i18n";

const ACTION_LABELS: Record<string, string> = {
  "login.ok": "Sign-in",
  "login.failed": "Failed sign-in",
  logout: "Sign-out",
  "totp.enabled": "Two-factor authentication enabled",
  "totp.disabled": "Two-factor authentication disabled",
  "totp.disable_failed": "Failed attempt to disable two-factor authentication",
  "account.create": "Create account",
  "account.delete": "Delete account",
  "account.quota": "Change quota",
  "domain.create": "Create subdomain",
  "domain.delete": "Delete subdomain",
  "domain.php": "Change PHP version",
  "certificate.set": "Install certificate",
};

export function ActivityPage() {
  const { t } = useTranslation();
  const entries = useQuery({ queryKey: ["audit"], queryFn: () => api.get<AuditEntryDto[]>("/audit") });

  return (
    <Page>
      <Card>
        <CardHeader>
          <CardTitle>{t("Activity")}</CardTitle>
          <CardDescription>{t("Log of the last 100 actions on the panel.")}</CardDescription>
        </CardHeader>
        <CardContent>
          {entries.isPending && <Skeleton className="h-40 w-full" />}
          {entries.isError && <p className="text-sm text-destructive">{entries.error.message}</p>}
          {entries.data && (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader className="bg-muted">
                  <TableRow>
                    <TableHead>{t("Date")}</TableHead>
                    <TableHead>{t("Action")}</TableHead>
                    <TableHead>{t("Details")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.data.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-muted-foreground">{formatDateTime(entry.at)}</TableCell>
                      <TableCell className="font-medium">{ACTION_LABELS[entry.action] ? t(ACTION_LABELS[entry.action]!) : entry.action}</TableCell>
                      <TableCell className="text-muted-foreground">{entry.detail ? serverText(entry.detail) : "—"}</TableCell>
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
