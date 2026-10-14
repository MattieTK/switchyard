import type { Adapter } from "../adapters/types.ts";
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

export interface PauseInfo {
  reason: string;
  actionLabel?: string;
  actionUrl?: string;
  reconnect?: Service;
}

export interface StepState {
  id: StepId;
  status: StepStatus;
  error?: string;
  pause?: PauseInfo;
  outputs: Record<string, string>;
}

export type JobStatus = "queued" | "running" | "paused" | "failed" | "done";

export interface Job {
  id: string;
  createdAt: string;
  accountId: string;
  plan: MigrationPlan;
  status: JobStatus;
  steps: StepState[];
}

export type JobEvent = { type: "log"; jobId: string; step: StepId; line: string } | { type: "job"; job: Job };

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
