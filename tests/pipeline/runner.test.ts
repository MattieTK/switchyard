import { describe, expect, it } from "vitest";
import { CommandError } from "../../src/exec.ts";
import { ApiError } from "../../src/http.ts";
import { BuildFailedError } from "../../src/pipeline/build-status.ts";
import type { MigrationPlan } from "../../src/pipeline/plan.ts";
import type { RecoveryRequest, RecoveryResult } from "../../src/pipeline/recovery.ts";
import { createRedactor } from "../../src/redact.ts";
import { createJobEvents } from "../../src/pipeline/events.ts";
import { createJobStore } from "../../src/pipeline/job-store.ts";
import { createJobQueue } from "../../src/pipeline/queue.ts";
import { resetForRestart, resetForRetry, runJob } from "../../src/pipeline/runner.ts";
import { type AgentRun, PauseError, type JobEvent, type PipelineDeps, type Step, type StepId } from "../../src/pipeline/types.ts";
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

  it("announces what a step is doing from the commands it runs and the lines they print", async () => {
    const { deps, job, seen } = await setup();
    const ran: string[] = [];
    const pipeline = {
      run: async (cmd: string, args: string[]) => {
        ran.push([cmd, ...args].join(" "));
        return { code: 0, output: "", stdout: "", stderr: "" };
      },
      ensurePackageManager: async () => {},
    } as unknown as PipelineDeps;
    const steps = [
      step("convert", async (ctx) => {
        await ctx.deps.ensurePackageManager("pnpm", "/w", ctx.log);
        await ctx.deps.run("pnpm", ["install"], { cwd: "/w" });
        await ctx.deps.run("git", ["status", "--porcelain"], { cwd: "/w" });
        ctx.log("Removing node_modules/");
        ctx.log("Progress: resolved 1");
      }),
    ];
    await runJob(job.id, steps, { ...deps, pipeline });
    expect(ran).toEqual(["pnpm install", "git status --porcelain"]);
    expect(seen.filter((e) => e.type === "activity")).toEqual([
      { type: "activity", jobId: job.id, step: "convert", text: "Setting up pnpm" },
      { type: "activity", jobId: job.id, step: "convert", text: "Installing dependencies" },
      { type: "activity", jobId: job.id, step: "convert", text: "Removing node_modules/" },
    ]);
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

describe("runJob with agent recovery", () => {
  const failing = (cmd = "pnpm") => new CommandError(cmd, ["run", "build"], { code: 1, output: "boom super-secret", stdout: "" });

  async function withAgent(over: { agent?: MigrationPlan["agent"] } = {}) {
    const s = await setup();
    const job = (await s.store.get(s.job.id))!;
    job.plan = { ...job.plan, agent: over.agent === undefined ? { id: "claude", model: "opus" } : over.agent };
    await s.store.save(job);
    const requests: RecoveryRequest[] = [];
    const answers: RecoveryResult[] = [];
    const recover = async (r: RecoveryRequest): Promise<RecoveryResult> => {
      requests.push(r);
      return answers.shift() ?? { recovered: false, note: "no answer", run: null };
    };
    return { ...s, requests, answers, deps: { ...s.deps, recover } };
  }

  const agentRun = (step: StepId, attempt: number, over: Partial<AgentRun> = {}): AgentRun => ({
    step,
    agent: "claude",
    attempt,
    startedAt: "2026-10-26T00:00:00.000Z",
    verdict: "fixed",
    summary: "fixed it",
    changedFiles: ["vite.config.ts"],
    ...over,
  });

  it("fails as before when no agent was chosen", async () => {
    const { deps, job, requests } = await withAgent({ agent: null });
    const done = await runJob(job.id, [step("build", async () => Promise.reject(failing()))], deps);
    expect(done.status).toBe("failed");
    expect(requests).toEqual([]);
  });

  it("runs the step again after the agent fixed it, and records that the re-run passed", async () => {
    const { deps, job, answers, requests } = await withAgent();
    answers.push({ recovered: true, run: agentRun("build", 1) });
    let runs = 0;
    const done = await runJob(
      job.id,
      [
        step("build", async () => {
          runs++;
          if (runs === 1) throw failing();
        }),
      ],
      deps,
    );
    expect(done.status).toBe("done");
    expect(runs).toBe(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ step: "build", attempt: 1, previous: [] });
    expect(done.agentRuns).toEqual([{ ...agentRun("build", 1), rerunPassed: true }]);
  });

  it("stops after two attempts and tells the second about the first", async () => {
    const { deps, job, answers, requests } = await withAgent();
    answers.push({ recovered: true, run: agentRun("build", 1) }, { recovered: true, run: agentRun("build", 2) });
    const done = await runJob(job.id, [step("build", async () => Promise.reject(failing()))], deps);
    expect(done.status).toBe("failed");
    expect(requests.map((r) => r.attempt)).toEqual([1, 2]);
    expect(requests[1]?.previous).toEqual([
      { attempt: 1, changedFiles: ["vite.config.ts"], summary: "fixed it", error: expect.stringContaining("exited with code 1") },
    ]);
    expect(done.agentRuns?.map((r) => r.rerunPassed)).toEqual([undefined, undefined]);
  });

  it("adds the agent's reason to the step's error when it can't recover", async () => {
    const { deps, job, answers } = await withAgent();
    answers.push({ recovered: false, note: "Claude couldn't fix it: needs a Supabase key", run: agentRun("build", 1, { verdict: "cannot-fix" }) });
    const done = await runJob(job.id, [step("build", async () => Promise.reject(failing()))], deps);
    expect(done.steps.find((s) => s.id === "build")?.error).toBe(
      "pnpm run build exited with code 1. The output is in the log. Claude couldn't fix it: needs a Supabase key",
    );
    expect(done.agentRuns).toHaveLength(1);
  });

  it("leaves pauses, plain errors and steps it doesn't cover to the user", async () => {
    const { deps, job, requests } = await withAgent();
    await runJob(job.id, [step("build", async () => Promise.reject(new Error("The Worker wasn't found")))], deps);
    await runJob(job.id, [step("build", async () => Promise.reject(new PauseError({ reason: "install the app" })))], deps);
    await runJob(job.id, [step("push", async () => Promise.reject(failing("git")))], deps);
    expect(requests).toEqual([]);
  });

  it("runs from the build again when the Cloudflare build failed", async () => {
    const { deps, job, answers } = await withAgent();
    answers.push({ recovered: true, run: agentRun("start-build", 1) });
    const order: string[] = [];
    let cloudRuns = 0;
    const steps = (["build", "deploy", "push", "pr", "builds"] as const).map((id) =>
      step(id, async (ctx) => {
        order.push(id);
        ctx.outputs.ran = "yes";
      }),
    );
    steps.push(
      step("start-build", async () => {
        order.push("start-build");
        if (++cloudRuns === 1) throw new BuildFailedError("The Cloudflare build finished with \"fail\".", "npm ERR!");
      }),
    );
    const done = await runJob(job.id, steps, deps);
    expect(done.status).toBe("done");
    expect(order).toEqual(["build", "deploy", "push", "pr", "builds", "start-build", "build", "deploy", "push", "pr", "builds", "start-build"]);
    expect(done.agentRuns?.[0]?.rerunPassed).toBe(true);
  });

  it("keeps the fix commit for the conversion", async () => {
    const { deps, job, answers } = await withAgent();
    answers.push({ recovered: true, run: agentRun("convert", 1, { fixCommit: "abc123" }) });
    let runs = 0;
    const done = await runJob(job.id, [step("convert", async () => (++runs === 1 ? Promise.reject(failing()) : undefined))], deps);
    expect(done.fixBase).toBe("abc123");
    expect(done.status).toBe("done");
  });

  it("never passes values to the recovery unredacted", async () => {
    const { deps, job, requests } = await withAgent();
    await runJob(job.id, [step("build", async () => Promise.reject(failing()))], deps);
    expect(requests[0]?.failure.output).toBe("boom ***");
  });
});

describe("resetForRestart", () => {
  it("forgets agent changes, since the job starts again from the production branch", async () => {
    const { job } = await setup();
    const r = resetForRestart({ ...job, fixBase: "abc", agentRuns: [] });
    expect(r.fixBase).toBeUndefined();
    expect(r.agentRuns).toBeUndefined();
  });

  it("sets every step back to pending, so the job runs again from the clone", async () => {
    const { job } = await setup();
    job.steps[0]!.status = "done";
    job.steps[0]!.outputs = { dir: "/w/j" };
    job.steps[2]!.status = "failed";
    job.steps[2]!.error = "x";
    job.status = "failed";
    const r = resetForRestart(job);
    expect(r.status).toBe("queued");
    expect(r.steps).toEqual(job.steps.map((s) => ({ id: s.id, status: "pending", outputs: {} })));
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
