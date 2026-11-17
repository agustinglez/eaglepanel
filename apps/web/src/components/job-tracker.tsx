import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobDto } from "@eaglepanel/shared";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { JobStatusBadge } from "@/components/job-status";
import { api } from "@/lib/api";
import { serverText } from "@/lib/i18n";

const isRunning = (job?: JobDto) => !job || job.status === "pending" || job.status === "running";

/** Shows a job's progress and refreshes data when it finishes. */
export function JobTracker({ jobId, onFinished }: { jobId: string; onFinished?: (job: JobDto) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const job = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.get<JobDto>(`/jobs/${jobId}`),
    refetchInterval: (query) => (isRunning(query.state.data) ? 1000 : false),
  });

  const finished = job.data && !isRunning(job.data) ? job.data : null;
  useEffect(() => {
    if (!finished) return;
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    onFinished?.(finished);
    // Runs once per job, when it finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished?.id, finished?.status]);

  if (!job.data) return <p className="text-sm text-muted-foreground">{t("Starting…")}</p>;

  return (
    <div role="status" className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium">{serverText(job.data.title)}</p>
        <JobStatusBadge status={job.data.status} />
      </div>
      {job.data.error && <p className="text-sm text-destructive">{serverText(job.data.error)}</p>}
      <ol className="flex flex-col gap-1.5">
        {job.data.steps.map((step) => (
          <li key={step.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-muted-foreground">{serverText(step.name)}</span>
            <JobStatusBadge status={step.status} />
          </li>
        ))}
      </ol>
    </div>
  );
}
