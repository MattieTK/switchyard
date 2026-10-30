import type { Adapter } from "../adapters/types.ts";
import type { CloudflareClient } from "../clients/cloudflare.ts";
import type { GitHubClient } from "../clients/github.ts";
import type { OpenAIClient } from "../clients/openai.ts";
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

export interface Job {
  id: string;
  createdAt: string;
  accountId: string;
  plan: MigrationPlan;
  status: JobStatus;
  steps: StepState[];
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
  // The OpenAI client and model that fix failed builds, or null when OpenAI isn't connected.
  openai(): Promise<{ client: OpenAIClient; model: string } | null>;
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
  // Hides every secret value the job knows of, for text that leaves this machine.
  redact(text: string): string;
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
