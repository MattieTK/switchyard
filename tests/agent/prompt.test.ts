import { describe, expect, it } from "vitest";
import { agentPrompt, MAX_FAILURE_OUTPUT, type PromptContext } from "../../src/agent/prompt.ts";
import { STEP_IDS, type Job, type StepState } from "../../src/pipeline/types.ts";
import { samplePlan } from "../helpers/sample-plan.ts";

function job(over: Partial<Job> = {}): Job {
  const steps: StepState[] = STEP_IDS.map((id) => ({ id, status: "pending", outputs: {} }));
  const byId = (id: string) => steps.find((s) => s.id === id)!;
  byId("clone").status = "done";
  byId("clone").outputs = { dir: "/work/job" };
  byId("convert").status = "done";
  byId("convert").outputs = {
    projectDir: "/work/job",
    warnings: JSON.stringify(["Switchyard added legacy-peer-deps=true to .npmrc."]),
  };
  byId("build").status = "failed";
  return {
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-10-26T00:00:00.000Z",
    accountId: "acc",
    plan: {
      ...samplePlan,
      upgrade: { from: "14.2.3", to: "16.4.1" },
      options: { adoptionCodemods: false, eslintMigration: true, updateFlaggedPackages: false, switchToPnpm: true },
      switchedFrom: "npm",
      packageManager: "pnpm",
    },
    status: "running",
    steps,
    ...over,
  };
}

function context(over: Partial<PromptContext> = {}): PromptContext {
  return {
    job: job(),
    step: "build",
    projectDir: "/work/job",
    failure: { command: "pnpm run build:cloudflare", exitCode: 1, output: "Error: MISSING_EXPORT foo" },
    stepLog: ["> vite build", "transforming..."],
    previous: [],
    buildVariableNames: ["NEXT_PUBLIC_API_URL", "DATABASE_URL"],
    ...over,
  };
}

describe("agentPrompt", () => {
  it("states the target: the step, the command and the folder", () => {
    const text = agentPrompt(context());
    expect(text).toContain(samplePlan.projectName);
    expect(text).toContain("`pnpm run build:cloudflare`");
    expect(text).toContain("/work/job");
  });

  it("lists what Switchyard has done", () => {
    const text = agentPrompt(context());
    expect(text).toContain("Next.js was upgraded from 14.2.3 to 16.4.1");
    expect(text).toContain("moved from npm to pnpm");
    expect(text).toContain("ESLint migration");
    expect(text).toContain("Switchyard added legacy-peer-deps=true to .npmrc.");
    expect(text).toMatch(/Clone the repository: done/);
    expect(text).toContain("cloudflare.config.ts");
  });

  it("names the build variables without their values", () => {
    const text = agentPrompt(context());
    expect(text).toContain("NEXT_PUBLIC_API_URL");
    expect(text).toContain("DATABASE_URL");
  });

  it("includes the failure, keeping the end of long output", () => {
    const long = `${"a".repeat(MAX_FAILURE_OUTPUT)}THE-END`;
    const text = agentPrompt(context({ failure: { command: "cf build", exitCode: 1, output: long } }));
    expect(text).toContain("THE-END");
    expect(text).not.toContain("a".repeat(MAX_FAILURE_OUTPUT));
    expect(text).toContain("exited with code 1");
    expect(text).toContain("transforming...");
  });

  it("includes the Workers Builds log for the first Cloudflare build", () => {
    const text = agentPrompt(
      context({
        step: "start-build",
        failure: { command: "Workers Builds", exitCode: null, output: "The build failed", cloudflareLog: "npm ERR! peer dep" },
      }),
    );
    expect(text).toContain("Workers Builds");
    expect(text).toContain("npm ERR! peer dep");
  });

  it("tells a convert recovery it's working on the project before conversion", () => {
    const text = agentPrompt(context({ step: "convert", failure: { command: "pnpm dlx vinext@1.1.0 init", exitCode: 1, output: "x" } }));
    expect(text).toContain("before conversion");
    expect(text).toContain("vinext init");
  });

  it("lists earlier attempts", () => {
    const text = agentPrompt(
      context({ previous: [{ attempt: 1, changedFiles: ["vite.config.ts"], summary: "aliased node-fetch", error: "still failing: n.call" }] }),
    );
    expect(text).toContain("Attempt 1");
    expect(text).toContain("vite.config.ts");
    expect(text).toContain("aliased node-fetch");
    expect(text).toContain("still failing: n.call");
  });

  it("ends with the rules and the verdict format", () => {
    const text = agentPrompt(context());
    expect(text).toContain("Don't commit, push or deploy");
    expect(text).toContain("SWITCHYARD: fixed – <one sentence");
    expect(text).toContain("SWITCHYARD: cannot fix – <reason>");
  });
});
