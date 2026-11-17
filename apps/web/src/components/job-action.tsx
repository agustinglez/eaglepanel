import { useMutation } from "@tanstack/react-query";
import type { JobCreatedDto } from "@eaglepanel/shared";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { JobTracker } from "@/components/job-tracker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** Starts a job: shows its error if it fails to start, or its progress if it starts. */
export function useJobAction<T = void, R extends Pick<JobCreatedDto, "secret"> & { jobId: string | null } = JobCreatedDto>(run: (input: T) => Promise<R>) {
  const [jobId, setJobId] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: run, onMutate: () => setJobId(null), onSuccess: ({ jobId: id }) => setJobId(id) });
  return { ...mutation, jobId };
}

export function ActionFeedback({ action, onFinished }: { action: { isError: boolean; error: Error | null; jobId: string | null }; onFinished?: (ok: boolean) => void }) {
  return (
    <>
      {action.isError && (
        <Alert variant="destructive">
          <AlertDescription>{action.error?.message}</AlertDescription>
        </Alert>
      )}
      {action.jobId && <JobTracker jobId={action.jobId} onFinished={(job) => onFinished?.(job.status === "succeeded")} />}
    </>
  );
}

export function CopyField({ value, id, mono }: { value: string; id?: string; mono?: boolean }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Input id={id} readOnly value={value} className={mono ? "min-w-0 flex-1 font-mono" : "min-w-0 flex-1"} />
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={t("Copy")}
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

/** A generated password is shown only here: the panel does not store it. */
export function SecretDialog({ title, secret, onClose, description }: { title: string; secret: string | null; onClose: () => void; description?: string }) {
  const { t } = useTranslation();
  return (
    <Dialog open={secret !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? t("Save it now. It will not be shown again.")}</DialogDescription>
        </DialogHeader>
        <CopyField value={secret ?? ""} mono />
        <DialogFooter><Button onClick={onClose}>{t("I saved it")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
