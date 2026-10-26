import { join } from "node:path";
import type { AgentDrivers } from "../agent/drivers.ts";
import { agentPrompt, type FailureInfo, type PreviousAttempt } from "../agent/prompt.ts";
import { recoverWithAgent } from "../agent/recover.ts";
import { AGENT_LABELS } from "../agent/types.ts";
import { CommandError, runOrThrow } from "../exec.ts";
import type { Redactor } from "../redact.ts";
import { triggerVariables, type EnvValues } from "../translate/env-plan.ts";
import { installCommand, installEnv, type PackageManager } from "../translate/package-manager.ts";
import { BuildFailedError } from "./build-status.ts";
import type { JobStore } from "./job-store.ts";
import { projectDirFor } from "./steps/shared.ts";
import type { AgentRun, Job, PipelineDeps, StepId } from "./types.ts";

export const MAX_AGENT_ATTEMPTS = 2;
export const AGENT_TIMEOUT_MS = 15 * 60_000;

// The steps an agent may recover, the step Switchyard runs again from afterwards, and whether
// the agent works on the converted tree as it is or on a clean checkout it then commits.
export const RECOVERABLE: Partial<Record<StepId, { rerunFrom: StepId; mode: "in-place" | "fix-layer" }>> = {
  convert: { rerunFrom: "convert", mode: "fix-layer" },
  build: { rerunFrom: "build", mode: "in-place" },
  deploy: { rerunFrom: "deploy", mode: "in-place" },
  // The fix has to pass a local build before Switchyard spends a push and a Cloudflare build on it.
  "start-build": { rerunFrom: "build", mode: "in-place" },
};

// What an agent is told about a failure. Only a command that failed, or a Cloudflare build,
// counts: other errors are Switchyard's own, and an agent shouldn't work around those.
export function failureInfo(e: unknown, redact: (text: string) => string): FailureInfo | null {
  if (e instanceof CommandError) return { command: redact(e.command), exitCode: e.code, output: redact(e.output) };
  if (e instanceof BuildFailedError) {
    return { command: "Workers Builds", exitCode: null, output: redact(e.message), cloudflareLog: redact(e.log) };
  }
  return null;
}

export interface RecoveryRequest {
  job: Job;
  step: StepId;
  failure: FailureInfo;
  values: EnvValues;
  attempt: number;
  previous: PreviousAttempt[];
  log(line: string): void;
}

export interface RecoveryResult {
  recovered: boolean;
  // The agent run to record, when the agent ran.
  run: AgentRun | null;
  // Added to the step's error when the step won't run again.
  note?: string;
}

// Folders package managers write to while installing, which a sandboxed agent needs.
async function packageCacheDirs(run: PipelineDeps["run"], pm: PackageManager, cwd: string): Promise<string[]> {
  const ask: Record<PackageManager, [string, string[]]> = {
    pnpm: ["pnpm", ["store", "path"]],
    npm: ["npm", ["config", "get", "cache"]],
    yarn: ["yarn", ["cache", "dir"]],
    bun: ["bun", ["pm", "cache"]],
  };
  const [cmd, args] = ask[pm];
  try {
    const r = await run(cmd, args, { cwd, timeoutMs: 30_000 });
    const dir = r.stdout.trim().split("\n").at(-1)?.trim();
    return r.code === 0 && dir?.startsWith("/") ? [dir] : [];
  } catch {
    return [];
  }
}

export const heldDevVarsPath = (configDir: string, jobId: string) => join(configDir, "jobs", `${jobId}.dev.vars.held`);

// A job whose agent run was cut short, by Switchyard stopping, has the agent's unfinished edits in
// its working copy. Converting again from a clean checkout (or the committed fix layer) drops
// them, so a retry never builds or pushes work nobody checked.
export function discardInterruptedAgentWork(job: Job): Job {
  const from = job.steps.findIndex((s) => s.id === "convert");
  return {
    ...job,
    steps: job.steps.map((s, i) => (i >= from && from >= 0 ? { id: s.id, status: "pending", outputs: {} } : s)),
  };
}

// Files whose undoing leaves node_modules out of step with them.
const DEPENDENCY_FILES = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc\.yml)$/;

export function createRecovery(d: {
  agents: AgentDrivers;
  store: JobStore;
  redactor: Redactor;
  pipeline: PipelineDeps;
  // Switchyard's own folder: saved values, credentials and logs. Agents are kept out of it where
  // they can be, and .dev.vars waits there while an agent runs.
  configDir: string;
  now?: () => Date;
}): (r: RecoveryRequest) => Promise<RecoveryResult> {
  const now = d.now ?? (() => new Date());

  return async ({ job, step, failure, values, attempt, previous, log }) => {
    const choice = job.plan.agent;
    const mode = RECOVERABLE[step]?.mode;
    if (!choice || !mode) return { recovered: false, run: null };
    const driver = d.agents[choice.id];
    const label = AGENT_LABELS[choice.id];

    const status = await driver.status();
    if (!status.signedIn) return { recovered: false, run: null, note: `${label} couldn't be asked to fix it: ${status.detail}.` };

    const repoDir = job.steps.find((s) => s.id === "clone")?.outputs.dir;
    const repo = job.plan.repo;
    if (!repoDir || !repo) return { recovered: false, run: null };
    const projectDir = projectDirFor(repoDir, repo.rootDirectory);
    const run = d.pipeline.run;

    // The agent fixes the project as it is before conversion, starting from the same clean
    // checkout convert starts from.
    if (mode === "fix-layer") {
      await runOrThrow(run, "git", ["reset", "--hard", job.fixBase ?? `origin/${repo.productionBranch}`], { cwd: repoDir });
      await runOrThrow(run, "git", ["clean", "-fdx"], { cwd: repoDir });
    }

    await d.store.flush(job.id);
    const prefix = `[${step}] `;
    const stepLog = (await d.store.readLog(job.id))
      .split("\n")
      .filter((l) => l.startsWith(prefix) && !l.startsWith(`${prefix}Agent:`))
      .map((l) => l.slice(prefix.length));
    const prompt = agentPrompt({
      job,
      step,
      projectDir,
      repoDir,
      failure,
      stepLog,
      previous,
      buildVariableNames: Object.keys(triggerVariables(job.plan.env, values, "production")),
    });

    log(`Agent: asking ${label} to fix this (attempt ${attempt} of ${MAX_AGENT_ATTEMPTS})`);
    const startedAt = now().toISOString();
    // In a monorepo, installs write the root's node_modules and lockfile, so the root is writable.
    const writableDirs = [
      ...(projectDir !== repoDir ? [repoDir] : []),
      ...(await packageCacheDirs(run, job.plan.packageManager, projectDir)),
    ];
    const outcome = await recoverWithAgent({
      driver,
      run,
      repoDir,
      projectDir,
      prompt,
      model: choice.model,
      writableDirs,
      protectedPaths: [d.configDir],
      heldDevVarsPath: heldDevVarsPath(d.configDir, job.id),
      scratchDir: join(d.pipeline.workDir, `${job.id}.agent`),
      // Numbered across the job, so a retry's runs don't replace earlier ones.
      eventsPath: d.store.agentEventsFile(job.id, step, (job.agentRuns?.length ?? 0) + 1),
      redact: (t) => d.redactor.redact(t),
      log,
      timeoutMs: AGENT_TIMEOUT_MS,
      commitAs: mode === "fix-layer" ? { agentLabel: label } : undefined,
    });

    const record: AgentRun = {
      step,
      agent: choice.id,
      ...(choice.model ? { model: choice.model } : {}),
      attempt,
      startedAt,
      verdict: outcome.verdict,
      summary: outcome.summary,
      changedFiles: outcome.changedFiles,
      ...(outcome.fixCommit ? { fixCommit: outcome.fixCommit } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    if (outcome.error) {
      // The agent's dependency changes were undone, but what it installed is still in
      // node_modules, where a retry would build against it. Convert installs from scratch anyway.
      if (mode === "in-place" && outcome.changedFiles.some((f) => DEPENDENCY_FILES.test(f))) {
        const install = installCommand(job.plan.packageManager);
        log("Agent: reinstalling dependencies, since the agent's changes to them were undone");
        await run(install.cmd, install.args, { cwd: projectDir, onLine: log, env: installEnv(job.plan.packageManager) });
      }
      return { recovered: false, run: record, note: outcome.error };
    }
    log(`Agent: ${label} changed ${outcome.changedFiles.join(", ")}. Switchyard is running the step again.`);
    return { recovered: true, run: record };
  };
}
