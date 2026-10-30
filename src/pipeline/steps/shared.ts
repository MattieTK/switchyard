import { join } from "node:path";
import { runOrThrow, type RunResult } from "../../exec.ts";
import { triggerVariables } from "../../translate/env-plan.ts";
import type { MigrationPlan } from "../plan.ts";
import type { StepContext, StepId } from "../types.ts";

export function requireRepo(plan: MigrationPlan): NonNullable<MigrationPlan["repo"]> {
  if (!plan.repo) throw new Error("This plan has no repository to work on.");
  return plan.repo;
}

export function requireOutput(ctx: StepContext, step: StepId, key: string): string {
  const value = ctx.output(step)[key];
  if (!value) throw new Error(`The ${step} step didn't record ${key}. Retry from that step.`);
  return value;
}

export function projectDirFor(repoDir: string, rootDirectory: string): string {
  return rootDirectory ? join(repoDir, rootDirectory) : repoDir;
}

export function git(ctx: StepContext, cwd: string, env: Record<string, string> = {}) {
  return (args: readonly string[]): Promise<RunResult> =>
    runOrThrow(ctx.deps.run, "git", args, { cwd, env, onLine: ctx.log });
}

// NEXT_PUBLIC_* values are inlined at build time, and some apps validate their environment while
// building, so local builds need the same production values Workers Builds will be given.
export function productionBuildEnv(ctx: StepContext): Record<string, string> {
  return buildEnv(ctx, "production");
}

// The variables a Workers Builds trigger builds with.
export function buildEnv(ctx: StepContext, which: "production" | "preview"): Record<string, string> {
  return Object.fromEntries(Object.entries(triggerVariables(ctx.job.plan.env, ctx.values, which)).map(([k, v]) => [k, v.value]));
}
