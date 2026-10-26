import type { CloudflareClient } from "../../src/clients/cloudflare.ts";
import type { GitHubClient } from "../../src/clients/github.ts";
import type { MigrationPlan } from "../../src/pipeline/plan.ts";
import { STEP_IDS, type Job, type PipelineDeps, type StepContext, type StepId } from "../../src/pipeline/types.ts";
import type { EnvValues } from "../../src/translate/env-plan.ts";
import { fakeRunner } from "./fake-runner.ts";
import { samplePlan } from "./sample-plan.ts";

export function makeContext(
  over: {
    plan?: Partial<MigrationPlan>;
    values?: EnvValues;
    deps?: Partial<PipelineDeps>;
    outputs?: Partial<Record<StepId, Record<string, string>>>;
  } = {},
): { ctx: StepContext; job: Job; logs: string[]; secrets: string[] } {
  const logs: string[] = [];
  const secrets: string[] = [];
  const job: Job = {
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-10-14T00:00:00.000Z",
    accountId: "acc",
    plan: { ...samplePlan, ...over.plan },
    status: "running",
    steps: STEP_IDS.map((id) => ({ id, status: "pending", outputs: { ...over.outputs?.[id] } })),
  };
  const deps: PipelineDeps = {
    run: fakeRunner().run,
    cloudflare: {} as CloudflareClient,
    github: async () => ({}) as GitHubClient,
    githubToken: async () => "gh-token",
    cloudflareToken: async () => "cf-token",
    adapter: () => null,
    ensurePackageManager: async () => {},
    saveScreenshot: async () => {},
    workDir: "/tmp/switchyard-test-work",
    sleep: async () => {},
    now: () => 0,
    ...over.deps,
  };
  const ctx: StepContext = {
    job,
    values: over.values ?? {},
    deps,
    log: (l) => logs.push(l),
    addSecret: (s) => secrets.push(s),
    outputs: {},
    output: (id) => job.steps.find((s) => s.id === id)?.outputs ?? {},
  };
  return { ctx, job, logs, secrets };
}
