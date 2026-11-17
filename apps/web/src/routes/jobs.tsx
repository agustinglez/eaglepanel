import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobDto } from "@eaglepanel/shared";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { JobStatusBadge } from "@/components/job-status";
import { Page } from "@/components/app-shell";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { serverText } from "@/lib/i18n";

/** Live updates for jobs that are still running. */
function useJobStream(job: JobDto) {
  const queryClient = useQueryClient();
  const active = job.status === "pending" || job.status === "running";

  useEffect(() => {
    if (!active) return;
    const source = new EventSource(`/api/jobs/${job.id}/stream`);
    source.addEventListener("job", (event) => {
      const updated = JSON.parse(event.data) as JobDto;
      queryClient.setQueryData<JobDto[]>(["jobs"], (jobs) => jobs?.map((item) => (item.id === updated.id ? updated : item)));
      if (updated.status !== "pending" && updated.status !== "running") source.close();
    });
    return () => source.close();
  }, [active, job.id, queryClient]);
}

function JobCard({ job }: { job: JobDto }) {
  useTranslation();
  useJobStream(job);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{serverText(job.title)}</CardTitle>
        <CardDescription>{formatDateTime(job.createdAt)}</CardDescription>
        <CardAction><JobStatusBadge status={job.status} /></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {job.error && <p className="text-sm text-destructive">{serverText(job.error)}</p>}
        <ol className="flex flex-col gap-1.5">
          {job.steps.map((step) => (
            <li key={step.id} className="text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-muted-foreground">{serverText(step.name)}</span>
                <JobStatusBadge status={step.status} />
              </div>
              {step.error && <p className="mt-0.5 text-destructive">{serverText(step.error)}</p>}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export function JobsPage() {
  const { t } = useTranslation();
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api.get<JobDto[]>("/jobs") });

  return (
    <Page>
      {jobs.isPending && <Skeleton className="h-32 w-full" />}
      {jobs.isError && <p className="text-sm text-destructive">{jobs.error.message}</p>}
      {jobs.data?.length === 0 && <p className="text-sm text-muted-foreground">{t("No jobs yet.")}</p>}
      {jobs.data?.map((job) => <JobCard key={job.id} job={job} />)}
    </Page>
  );
}
