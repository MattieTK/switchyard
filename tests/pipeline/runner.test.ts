import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/http.ts";
import { createRedactor } from "../../src/redact.ts";
import { createJobEvents } from "../../src/pipeline/events.ts";
import { createJobStore } from "../../src/pipeline/job-store.ts";
import { createJobQueue } from "../../src/pipeline/queue.ts";
import { resetForRetry, runJob } from "../../src/pipeline/runner.ts";
import { PauseError, type JobEvent, type PipelineDeps, type Step, type StepId } from "../../src/pipeline/types.ts";
import { samplePlan } from "../helpers/sample-plan.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const step = (id: StepId, run: Step["run"]): Step => ({ id, title: id, run });

async function setup() {
  const store = createJobStore(await makeTempDir());
  const events = createJobEvents();
  const redactor = createRedactor();
  const job = await store.create(samplePlan, "acc", { e1: "super-secret" });
  const seen: JobEvent[] = [];
  events.subscribe(job.id, (e) => seen.push(e));
  return { store, events, redactor, job, seen, deps: { store, events, redactor, pipeline: {} as PipelineDeps } };
}

describe("runJob", () => {
  it("runs steps in order, shares outputs, redacts logs and deletes values when done", async () => {
    const { deps, job, seen, store } = await setup();
    const steps = [
      step("clone", async (ctx) => {
        ctx.outputs.dir = "/w";
        ctx.log(`using ${ctx.values.e1}`);
      }),
      step("convert", async (ctx) => {
        expect(ctx.output("clone").dir).toBe("/w");
      }),
    ];
    const done = await runJob(job.id, steps, deps);
    expect(done.status).toBe("done");
    expect(done.steps.slice(0, 2).map((s) => s.status)).toEqual(["done", "done"]);
    expect(seen).toContainEqual({ type: "log", jobId: job.id, step: "clone", line: "using ***" });
    expect(await store.readLog(job.id)).toContain("[clone] using ***");
    expect(await store.readValues(job.id)).toEqual({});
  });

  it("pauses on PauseError and resumes from that step after a retry", async () => {
    const { deps, job, store } = await setup();
    let attempts = 0;
    let cloneRuns = 0;
    const steps = [
      step("clone", async (ctx) => {
        cloneRuns++;
        ctx.outputs.dir = "/w";
      }),
      step("convert", async () => {
        attempts++;
        if (attempts === 1) throw new PauseError({ reason: "Install the app", actionUrl: "https://x" });
      }),
    ];
    const paused = await runJob(job.id, steps, deps);
    expect(paused.status).toBe("paused");
    expect(paused.steps[1]).toMatchObject({ status: "paused", pause: { reason: "Install the app" } });
    await store.save(resetForRetry(paused));
    const done = await runJob(job.id, steps, deps);
    expect(done.status).toBe("done");
    expect(attempts).toBe(2);
    expect(cloneRuns).toBe(1);
    expect(done.steps[0]).toMatchObject({ status: "done", outputs: { dir: "/w" } });
  });

  it.each([
    ["done", async () => {}],
    ["failed", async () => { throw new Error("boom"); }],
    ["paused", async () => { throw new PauseError({ reason: "Install the app" }); }],
  ] as const)("flushes the log before publishing the final %s state, so a retry can't be dropped", async (status, run) => {
    const { deps, job, store, events } = await setup();
    const order: string[] = [];
    const flush = store.flush.bind(store);
    deps.store = {
      ...store,
      flush: async (id: string) => {
        await flush(id);
        await new Promise((r) => setTimeout(r, 10));
        order.push("flush");
      },
    };
    events.subscribe(job.id, (e) => {
      if (e.type === "job") order.push(`job:${e.job.status}`);
    });
    await runJob(job.id, [step("clone", run)], deps);
    expect(order.at(-2)).toBe("flush");
    expect(order.at(-1)).toBe(`job:${status}`);
  });

  it("pauses for reconnection on auth errors", async () => {
    const { deps, job } = await setup();
    const r = await runJob(
      job.id,
      [
        step("clone", async () => {
          throw new ApiError("github", 401, "Bad credentials", true);
        }),
      ],
      deps,
    );
    expect(r.steps[0]?.pause?.reconnect).toBe("github");
  });

  it("fails on other errors with a redacted message and keeps values for the retry", async () => {
    const { deps, job, store } = await setup();
    const r = await runJob(
      job.id,
      [
        step("clone", async () => {
          throw new Error("leaked super-secret");
        }),
      ],
      deps,
    );
    expect(r.status).toBe("failed");
    expect(r.steps[0]?.error).toBe("leaked ***");
    expect(await store.readValues(job.id)).toEqual({ e1: "super-secret" });
  });
});

describe("resetForRetry", () => {
  it("sets failed and paused steps back to pending and leaves done steps alone", async () => {
    const { job } = await setup();
    job.steps[0]!.status = "done";
    job.steps[1]!.status = "failed";
    job.steps[1]!.error = "x";
    job.status = "failed";
    const r = resetForRetry(job);
    expect(r.status).toBe("queued");
    expect(r.steps[0]?.status).toBe("done");
    expect(r.steps[1]).toEqual({ id: "convert", status: "pending", outputs: {} });
  });
});

describe("createJobQueue", () => {
  it("runs jobs one at a time, ignores duplicates and survives errors", async () => {
    const order: string[] = [];
    const errors: string[] = [];
    const queue = createJobQueue(
      async (id) => {
        order.push(`start ${id}`);
        await new Promise((r) => setTimeout(r, 5));
        if (id === "b") throw new Error("boom");
        order.push(`end ${id}`);
      },
      (id) => errors.push(id),
    );
    queue.enqueue("a");
    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");
    await queue.idle();
    expect(order).toEqual(["start a", "end a", "start b", "start c", "end c"]);
    expect(errors).toEqual(["b"]);
  });
});
