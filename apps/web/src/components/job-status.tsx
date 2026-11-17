import type { JobStatus, JobStepStatus } from "@eaglepanel/shared";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

type Status = JobStatus | JobStepStatus;

const LABELS: Record<Status, string> = {
  pending: "Queued",
  running: "Running",
  succeeded: "Completed",
  rolled_back: "Rolled back",
  rollback_failed: "Rollback failed",
  interrupted: "Interrupted",
  failed: "Failed",
  compensated: "Rolled back",
  compensation_failed: "Rollback failed",
};

const VARIANTS: Partial<Record<Status, "default" | "secondary" | "destructive" | "outline" | "success" | "warning">> = {
  running: "default",
  succeeded: "success",
  rollback_failed: "destructive",
  interrupted: "destructive",
  failed: "destructive",
  compensation_failed: "destructive",
};

export function JobStatusBadge({ status }: { status: Status }) {
  const { t } = useTranslation();
  return <Badge variant={VARIANTS[status] ?? "outline"}>{t(LABELS[status])}</Badge>;
}
