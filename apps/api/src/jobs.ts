import type { JobDto, JobStatus, JobStepStatus } from "@eaglepanel/shared";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { EventEmitter } from "node:events";
import type { Db } from "./db";
import { jobs, jobSteps } from "./db/schema";

export interface JobStep {
  name: string;
  /** Must be idempotent. */
  run: () => Promise<void>;
  /** Undoes `run`. Also called on the step that failed, which may have been left halfway. */
  compensate?: () => Promise<void>;
}

export interface JobDefinition {
  type: string;
  title: string;
  steps: JobStep[];
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs jobs one at a time, in order: two simultaneous changes would overwrite the OLS configuration. Backups and
 * restores use another lane: they can take hours and do not touch OLS, so they do not block the rest of the panel.
 */
export type JobLane = "main" | "backup";

export class JobRunner {
  readonly events = new EventEmitter();
  private readonly queues = new Map<JobLane, Promise<void>>();

  constructor(private readonly db: Db) {
    this.events.setMaxListeners(0);
  }

  /** Whatever was running when the process stopped is not resumed: its real state is unknown. */
  markInterrupted(): void {
    const stale = this.db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.status, ["pending", "running"])).all();
    for (const { id } of stale) {
      this.db.update(jobs).set({
        status: "interrupted",
        error: "The process stopped during the job. Its state must be checked manually.",
        finishedAt: Date.now(),
      }).where(eq(jobs.id, id)).run();
    }
  }

  enqueue(definition: JobDefinition, { lane = "main" }: { lane?: JobLane } = {}): { id: string; done: Promise<void> } {
    const id = crypto.randomUUID();
    this.db.transaction((tx) => {
      tx.insert(jobs).values({
        id,
        type: definition.type,
        title: definition.title,
        status: "pending",
        createdAt: Date.now(),
      }).run();
      definition.steps.forEach((step, position) => {
        tx.insert(jobSteps).values({ jobId: id, position, name: step.name, status: "pending" }).run();
      });
    });
    const done = (this.queues.get(lane) ?? Promise.resolve()).then(() => this.execute(id, definition));
    this.queues.set(lane, done);
    return { id, done };
  }

  get(id: string): JobDto | null {
    const job = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return null;
    const steps = this.db.select().from(jobSteps).where(eq(jobSteps.jobId, id)).orderBy(asc(jobSteps.position)).all();
    return { ...job, steps };
  }

  list(limit = 50): JobDto[] {
    const rows = this.db.select({ id: jobs.id }).from(jobs).orderBy(desc(jobs.createdAt)).limit(limit).all();
    return rows.map(({ id }) => this.get(id)).filter((job): job is JobDto => job !== null);
  }

  private async execute(id: string, definition: JobDefinition): Promise<void> {
    this.setJob(id, "running");

    let failure: { position: number; message: string } | null = null;
    for (const [position, step] of definition.steps.entries()) {
      this.setStep(id, position, "running", { startedAt: Date.now() });
      try {
        await step.run();
        this.setStep(id, position, "succeeded", { finishedAt: Date.now() });
      } catch (error) {
        const message = errorMessage(error);
        this.setStep(id, position, "failed", { error: message, finishedAt: Date.now() });
        failure = { position, message };
        break;
      }
    }

    if (!failure) {
      this.setJob(id, "succeeded");
      return;
    }

    const failedStepName = definition.steps[failure.position]?.name ?? "";
    let rollbackOk = true;
    for (let position = failure.position; position >= 0; position -= 1) {
      const step = definition.steps[position];
      if (!step?.compensate) continue;
      try {
        await step.compensate();
        if (position !== failure.position) {
          this.setStep(id, position, "compensated", {});
        }
      } catch (error) {
        rollbackOk = false;
        this.setStep(id, position, "compensation_failed", { error: errorMessage(error) });
      }
    }

    const summary = `Fallo "${failedStepName}": ${failure.message}`;
    this.setJob(id, rollbackOk ? "rolled_back" : "rollback_failed", summary);
  }

  private setJob(id: string, status: JobStatus, error?: string): void {
    const finished = status !== "pending" && status !== "running";
    this.db.update(jobs).set({
      status,
      error: error ?? null,
      finishedAt: finished ? Date.now() : null,
    }).where(eq(jobs.id, id)).run();
    this.emit(id);
  }

  private setStep(
    id: string,
    position: number,
    status: JobStepStatus,
    fields: { error?: string; startedAt?: number; finishedAt?: number },
  ): void {
    const rows = this.db.select().from(jobSteps).where(eq(jobSteps.jobId, id)).all();
    const row = rows.find((candidate) => candidate.position === position);
    if (!row) return;
    this.db.update(jobSteps).set({ status, ...fields }).where(eq(jobSteps.id, row.id)).run();
    this.emit(id);
  }

  private emit(id: string): void {
    this.events.emit(id, this.get(id));
  }
}
