import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { DEFAULT_LIMITS, type JobCreatedDto } from "@eaglepanel/shared";
import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { Page } from "@/components/app-shell";
import { SecretDialog } from "@/components/job-action";
import { JobTracker } from "@/components/job-tracker";
import { LimitFields, limitsFromForm, limitsToForm } from "@/components/limit-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";
import { PreflightWarning } from "@/routes/accounts";

export function NewAccountPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [limits, setLimits] = useState(() => limitsToForm(DEFAULT_LIMITS));
  const [jobId, setJobId] = useState<string | null>(null);
  const [ftpPassword, setFtpPassword] = useState<string | null>(null);
  const goToAccount = () => void navigate({ to: "/accounts/$username", params: { username } });

  const create = useMutation({
    mutationFn: () => api.post<JobCreatedDto>("/accounts", { username, limits: limitsFromForm(limits) }),
    onMutate: () => setJobId(null),
    onSuccess: ({ jobId: id }) => setJobId(id),
  });

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <Page>
      <PreflightWarning />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>{t("New account")}</CardTitle>
          <CardDescription>{t("Creates the user, its home directory, the disk quota and the general FTP account. Domains and environments are added from the account.")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-6">
            <div className="flex flex-col gap-4">
              <div className="grid gap-2">
                <Label htmlFor="username">{t("Username")}</Label>
                <Input id="username" value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} placeholder="acme" autoComplete="off" spellCheck={false} required />
              </div>
            </div>
            <Separator />
            <div className="flex flex-col gap-4">
              <div className="grid gap-1">
                <h3 className="text-sm font-medium">{t("Limits")}</h3>
                <p className="text-sm text-muted-foreground">{t("They can be changed later in the account settings.")}</p>
              </div>
              <LimitFields value={limits} onChange={setLimits} />
            </div>
            {create.isError && (
              <Alert variant="destructive">
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            )}
            {jobId && (
              <JobTracker
                jobId={jobId}
                onFinished={(job) => {
                  if (job.status !== "succeeded") return;
                  if (create.data?.secret) setFtpPassword(create.data.secret);
                  else goToAccount();
                }}
              />
            )}
            <div>
              <Button type="submit" disabled={create.isPending}>{t("Create account")}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <SecretDialog title={t("Account FTP password")} secret={ftpPassword} onClose={goToAccount} />
    </Page>
  );
}
