import { describe, expect, test } from "bun:test";
import { openDb } from "./db";
import { jobs } from "./db/schema";
import { JobRunner, type JobStep } from "./jobs";

function setup() {
  const db = openDb(":memory:");
  return { db, runner: new JobRunner(db) };
}

function step(name: string, log: string[], options: { fail?: boolean; failCompensate?: boolean } = {}): JobStep {
  return {
    name,
    run: async () => {
      log.push(`run:${name}`);
      if (options.fail) throw new Error(`boom ${name}`);
    },
    compensate: async () => {
      log.push(`undo:${name}`);
      if (options.failCompensate) throw new Error(`undo boom ${name}`);
    },
  };
}

describe("JobRunner", () => {
  test("runs the steps in order", async () => {
    const { runner } = setup();
    const log: string[] = [];
    const { id, done } = runner.enqueue({ type: "t", title: "T", steps: [step("a", log), step("b", log)] });
    await done;

    expect(log).toEqual(["run:a", "run:b"]);
    const job = runner.get(id);
    expect(job?.status).toBe("succeeded");
    expect(job?.steps.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);
    expect(job?.finishedAt).not.toBeNull();
  });

  test("if a step fails it rolls back in reverse order, including the one that failed", async () => {
    const { runner } = setup();
    const log: string[] = [];
    const { id, done } = runner.enqueue({
      type: "t",
      title: "T",
      steps: [step("a", log), step("b", log, { fail: true }), step("c", log)],
    });
    await done;

    expect(log).toEqual(["run:a", "run:b", "undo:b", "undo:a"]);
    const job = runner.get(id);
    expect(job?.status).toBe("rolled_back");
    expect(job?.error).toContain("boom b");
    expect(job?.steps.map((s) => s.status)).toEqual(["compensated", "failed", "pending"]);
  });

  test("a failed compensation does not stop the rest and is reported", async () => {
    const { runner } = setup();
    const log: string[] = [];
    const { id, done } = runner.enqueue({
      type: "t",
      title: "T",
      steps: [step("a", log), step("b", log, { failCompensate: true }), step("c", log, { fail: true })],
    });
    await done;

    expect(log).toEqual(["run:a", "run:b", "run:c", "undo:c", "undo:b", "undo:a"]);
    const job = runner.get(id);
    expect(job?.status).toBe("rollback_failed");
    expect(job?.steps[1]?.status).toBe("compensation_failed");
    expect(job?.steps[1]?.error).toContain("undo boom b");
  });

  test("does not run two jobs at once", async () => {
    const { runner } = setup();
    const log: string[] = [];
    const slow: JobStep = {
      name: "lento",
      run: async () => {
        log.push("inicio");
        await Bun.sleep(20);
        log.push("fin");
      },
    };
    const first = runner.enqueue({ type: "t", title: "1", steps: [slow] });
    const second = runner.enqueue({ type: "t", title: "2", steps: [step("b", log)] });
    await Promise.all([first.done, second.done]);

    expect(log).toEqual(["inicio", "fin", "run:b"]);
  });

  test("a failure does not block the queue", async () => {
    const { runner } = setup();
    const log: string[] = [];
    const first = runner.enqueue({ type: "t", title: "1", steps: [step("a", log, { fail: true })] });
    const second = runner.enqueue({ type: "t", title: "2", steps: [step("b", log)] });
    await Promise.all([first.done, second.done]);

    expect(runner.get(second.id)?.status).toBe("succeeded");
  });

  test("marks whatever was left running as interrupted", () => {
    const { db, runner } = setup();
    db.insert(jobs).values({ id: "x", type: "t", title: "T", status: "running", createdAt: 1 }).run();

    runner.markInterrupted();

    const job = runner.get("x");
    expect(job?.status).toBe("interrupted");
    expect(job?.error).toContain("checked manually");
  });
});
