import type { PreviousAttempt } from "../agent/prompt.ts";
import { CommandError } from "../exec.ts";
import { isAuthError, type Service } from "../http.ts";
import type { Redactor } from "../redact.ts";
import { activityFromLine, describeCommand } from "./activity.ts";
import type { JobEvents } from "./events.ts";
import type { JobStore } from "./job-store.ts";
import { failureInfo, MAX_AGENT_ATTEMPTS, RECOVERABLE, type RecoveryRequest, type RecoveryResult } from "./recovery.ts";
import { type AgentRun, PauseError, type Job, type PipelineDeps, type Step, type StepContext, type StepId } from "./types.ts";

export interface RunnerDeps {
  store: JobStore;
  events: JobEvents;
  redactor: Redactor;
  pipeline: PipelineDeps;
  // Asks the agent the plan names to recover a failed step. Without it, failed steps just fail.
  recover?: (r: RecoveryRequest) => Promise<RecoveryResult>;
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

  // Agent attempts made during this run, by the step that failed. Retry starts them again.
  const attempts = new Map<StepId, PreviousAttempt[]>();
  // A recovered step's agent run, until the step passes when it runs again.
  const awaitingRerun = new Map<StepId, AgentRun>();

  job.status = "running";
  await publish();

  // An index rather than for…of, so a recovery can go back to an earlier step.
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] as Step;
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
      announce(clean.startsWith("Agent: ") ? clean : activityFromLine(clean));
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
      const recovered = awaitingRerun.get(step.id);
      if (recovered) {
        recovered.rerunPassed = true;
        awaitingRerun.delete(step.id);
      }
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
        const error = d.redactor.redact(describe(e));
        const recovery = await recoverStep(step.id, e, error, log);
        if (recovery.rerunFrom) {
          // The steps from the re-run point to this one start again; their outputs described the
          // tree before the agent changed it. Their warnings stay: a repair such as an added
          // package isn't needed again on the re-run, but the pull request must still list it.
          // Later steps never ran, so they're still pending.
          const from = steps.findIndex((s) => s.id === recovery.rerunFrom);
          for (const s of steps.slice(from, index + 1)) {
            const st = job.steps.find((x) => x.id === s.id);
            if (!st) continue;
            const outputs = st.outputs.warnings ? { warnings: st.outputs.warnings } : {};
            Object.assign(st, { status: "pending", outputs, error: undefined, pause: undefined });
          }
          await publish();
          index = from - 1;
          continue;
        }
        state.status = "failed";
        state.error = recovery.note ? `${error} ${d.redactor.redact(recovery.note)}` : error;
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

  // Asks the plan's agent to recover a failed step, when the step and the failure allow it.
  // Returns where to run again from, or a note to add to the step's error.
  async function recoverStep(
    id: StepId,
    e: unknown,
    error: string,
    log: (line: string) => void,
  ): Promise<{ rerunFrom?: StepId; note?: string }> {
    const target = RECOVERABLE[id];
    const failure = failureInfo(e, (t) => d.redactor.redact(t));
    if (!d.recover || !job?.plan.agent || !target || !failure) return {};
    const previous = attempts.get(id) ?? [];
    if (previous.length >= MAX_AGENT_ATTEMPTS) return {};
    // The step failed again after the last attempt; that failure belongs to it.
    const last = previous.at(-1);
    if (last) last.error = error;
    log(error);

    let result: RecoveryResult;
    try {
      result = await d.recover({ job, step: id, failure, values, attempt: previous.length + 1, previous: [...previous], log });
    } catch (err) {
      return { note: `Asking the agent failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (result.run) {
      job.agentRuns = [...(job.agentRuns ?? []), result.run];
      if (result.run.fixCommit) job.fixBase = result.run.fixCommit;
      attempts.set(id, [
        ...previous,
        { attempt: result.run.attempt, changedFiles: result.run.changedFiles, summary: result.run.summary, error: "" },
      ]);
      if (result.recovered) awaitingRerun.set(id, result.run);
    }
    return result.recovered ? { rerunFrom: target.rerunFrom } : { note: result.note };
  }
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
// the Worker, branch, pull request and triggers they find. An agent's changes aren't kept:
// starting over means starting from the production branch.
export function resetForRestart(job: Job): Job {
  const { fixBase: _fixBase, agentRuns: _agentRuns, ...rest } = job;
  return { ...rest, status: "queued", steps: job.steps.map((s) => ({ id: s.id, status: "pending", outputs: {} })) };
}
