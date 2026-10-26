import type { Adapter } from "../adapters/types.ts";
import type { AgentId, Verdict } from "../agent/types.ts";
import type { CloudflareClient } from "../clients/cloudflare.ts";
import type { GitHubClient } from "../clients/github.ts";
import type { CommandRunner } from "../exec.ts";
import type { Service } from "../http.ts";
import type { EnvValues } from "../translate/env-plan.ts";
import type { PackageManager } from "../translate/package-manager.ts";
import type { MigrationPlan } from "./plan.ts";

export const STEP_IDS = ["clone", "convert", "build", "deploy", "push", "pr", "builds", "start-build"] as const;
export type StepId = (typeof STEP_IDS)[number];
export type StepStatus = "pending" | "running" | "done" | "failed" | "paused";

// The steps' titles, for text written outside the steps themselves, such as an agent's prompt.
export const STEP_TITLES: Record<StepId, string> = {
  clone: "Clone the repository",
  convert: "Convert the project",
  build: "Build locally with cf",
  deploy: "Create the Worker with a first deploy",
  push: "Push the migration branch",
  pr: "Open the pull request",
  builds: "Connect Workers Builds",
  "start-build": "Run the first Cloudflare build",
};

export interface PauseInfo {
  reason: string;
  actionLabel?: string;
  actionUrl?: string;
  reconnect?: Service;
  // Something the user enters on the job page to continue, such as a Cloudflare API token.
  input?: "cloudflare-build-token";
}

export interface StepState {
  id: StepId;
  status: StepStatus;
  error?: string;
  pause?: PauseInfo;
  outputs: Record<string, string>;
}

export type JobStatus = "queued" | "running" | "paused" | "failed" | "done";

// One time an agent was asked to recover a failed step.
export interface AgentRun {
  step: StepId;
  agent: AgentId;
  model?: string;
  attempt: number;
  startedAt: string;
  verdict: Verdict;
  // The agent's one-sentence account of what it changed, or why it couldn't.
  summary: string;
  changedFiles: string[];
  // Convert only: the commit holding the agent's changes.
  fixCommit?: string;
  // Why Switchyard didn't run the step again.
  error?: string;
  // Whether the step passed when it ran again afterwards. Unset until it has.
  rerunPassed?: boolean;
}

export interface Job {
  id: string;
  createdAt: string;
  accountId: string;
  plan: MigrationPlan;
  status: JobStatus;
  steps: StepState[];
  // Kept across retries, so the pull request and the job page can list every agent run.
  agentRuns?: AgentRun[];
  // The commit convert starts from instead of the production branch, once an agent fixed it.
  fixBase?: string;
}

export type JobEvent =
  | { type: "log"; jobId: string; step: StepId; line: string }
  // What the running step is doing right now, for display only; not saved.
  | { type: "activity"; jobId: string; step: StepId; text: string }
  | { type: "job"; job: Job };

export interface PipelineDeps {
  run: CommandRunner;
  cloudflare: CloudflareClient;
  github(): Promise<GitHubClient>;
  githubToken(): Promise<string>;
  cloudflareToken(): Promise<string>;
  adapter(id: string): Adapter | null;
  // Makes sure the project's package manager can run, setting it up if needed.
  ensurePackageManager(pm: PackageManager, cwd: string, log: (line: string) => void): Promise<void>;
  workDir: string;
  // Keeps a JPEG of a job's deployed site for the job page, or removes it when given null.
  saveScreenshot(jobId: string, image: Uint8Array | null): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface StepContext {
  job: Job;
  values: EnvValues;
  deps: PipelineDeps;
  log(line: string): void;
  addSecret(value: string): void;
  outputs: Record<string, string>;
  output(step: StepId): Record<string, string>;
}

export interface Step {
  id: StepId;
  title: string;
  run(ctx: StepContext): Promise<void>;
}

// Thrown by a step when it needs the user to do something before retrying.
export class PauseError extends Error {
  readonly pause: PauseInfo;

  constructor(pause: PauseInfo) {
    super(pause.reason);
    this.name = "PauseError";
    this.pause = pause;
  }
}
