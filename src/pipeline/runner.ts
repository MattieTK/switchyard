import { CommandError } from "../exec.ts";
import { isAuthError, type Service } from "../http.ts";
import type { Redactor } from "../redact.ts";
import { activityFromLine, describeCommand } from "./activity.ts";
import type { JobEvents } from "./events.ts";
import type { JobStore } from "./job-store.ts";
import { PauseError, type Job, type PipelineDeps, type Step, type StepContext } from "./types.ts";

export interface RunnerDeps {
  store: JobStore;
  events: JobEvents;
  redactor: Redactor;
  pipeline: PipelineDeps;
}

const SERVICE_NAMES: Record<Service, string> = { vercel: "Vercel", cloudflare: "Cloudflare", github: "GitHub" };

function describe(e: unknown): string {
  if (e instanceof CommandError) return `${e.message}. The output is in the log.`;
  return e instanceof Error ? e.message : String(e);
}

// The runner owns the job object while it runs and saves it after every change.
export async function runJob(jobId: string, steps: readonly Step[], d: RunnerDeps): Promise<Job> {
  const job = await d.store.get(jobId);
  if (!job) throw new Error(`Job ${jobId} was not found`);
  const values = await d.store.readValues(jobId);
  for (const v of Object.values(values)) d.redactor.add(v);

  const publish = async () => {
    await d.store.save(job);
    d.events.emit({ type: "job", job });
  };

  job.status = "running";
  await publish();

  for (const step of steps) {
    const state = job.steps.find((s) => s.id === step.id);
    if (!state) throw new Error(`Job ${jobId} has no state for step ${step.id}`);
    if (state.status === "done") continue;

    state.status = "running";
    delete state.error;
    delete state.pause;
    await publish();

    const announce = (text: string | null) => {
      if (text) d.events.emit({ type: "activity", jobId, step: step.id, text: d.redactor.redact(text) });
    };
    const log = (line: string) => {
      const clean = d.redactor.redact(line);
      void d.store
        .appendLog(jobId, `[${step.id}] ${clean}`)
        .catch(() => console.error(`Could not write the log for job ${jobId}`));
      d.events.emit({ type: "log", jobId, step: step.id, line: clean });
      announce(activityFromLine(clean));
    };
    // Each command a step starts, and each package manager it sets up, is announced first.
    const deps: PipelineDeps = {
      ...d.pipeline,
      run: (cmd, args, opts) => {
        announce(describeCommand(cmd, args));
        return d.pipeline.run(cmd, args, opts);
      },
      ensurePackageManager: (pm, cwd, onLine) => {
        announce(`Setting up ${pm}`);
        return d.pipeline.ensurePackageManager(pm, cwd, onLine);
      },
    };
    const ctx: StepContext = {
      job,
      values,
      deps,
      log,
      addSecret: (v) => d.redactor.add(v),
      outputs: state.outputs,
      output: (id) => job.steps.find((s) => s.id === id)?.outputs ?? {},
    };

    try {
      await step.run(ctx);
      state.status = "done";
      await publish();
    } catch (e) {
      if (e instanceof PauseError) {
        state.status = "paused";
        state.pause = { ...e.pause, reason: d.redactor.redact(e.pause.reason) };
        job.status = "paused";
      } else if (isAuthError(e)) {
        state.status = "paused";
        state.pause = {
          reason: `${SERVICE_NAMES[e.service]} needs reconnecting: ${d.redactor.redact(e.message)}`,
          reconnect: e.service,
        };
        job.status = "paused";
      } else {
        state.status = "failed";
        state.error = d.redactor.redact(describe(e));
        job.status = "failed";
      }
      log(state.error ?? state.pause?.reason ?? "Stopped");
      // Publishing is the last await: once the state says failed or paused, a Retry may enqueue
      // the job at any moment, and the queue drops it while this run is still in flight.
      await d.store.flush(jobId);
      await publish();
      return job;
    }
  }

  job.status = "done";
  await d.store.deleteValues(jobId);
  await d.store.flush(jobId);
  await publish();
  return job;
}

export function resetForRetry(job: Job): Job {
  return {
    ...job,
    status: "queued",
    steps: job.steps.map((s) =>
      s.status === "failed" || s.status === "paused" ? { id: s.id, status: "pending", outputs: {} } : s,
    ),
  };
}

// Runs every step again, so a fix to an earlier step, such as the conversion, reaches the
// later ones. Clone and convert start from a clean checkout, and the steps after them reuse
// the Worker, branch, pull request and triggers they find.
export function resetForRestart(job: Job): Job {
  return { ...job, status: "queued", steps: job.steps.map((s) => ({ id: s.id, status: "pending", outputs: {} })) };
}
