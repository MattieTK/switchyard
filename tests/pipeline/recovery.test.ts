import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDrivers } from "../../src/agent/drivers.ts";
import type { AgentDriver, AgentRequest, AgentStatus } from "../../src/agent/types.ts";
import { CommandError, createCommandRunner } from "../../src/exec.ts";
import { BuildFailedError } from "../../src/pipeline/build-status.ts";
import { createJobStore } from "../../src/pipeline/job-store.ts";
import { createRecovery, failureInfo } from "../../src/pipeline/recovery.ts";
import type { Job, PipelineDeps } from "../../src/pipeline/types.ts";
import { createRedactor } from "../../src/redact.ts";
import { samplePlan } from "../helpers/sample-plan.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const run = createCommandRunner();
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });

describe("failureInfo", () => {
  const redact = (t: string) => t.replaceAll("hunter2", "***");

  it("describes a failed command and a failed Cloudflare build, redacted", () => {
    const cmd = new CommandError("pnpm", ["run", "build"], { code: 2, output: "token hunter2", stdout: "" });
    expect(failureInfo(cmd, redact)).toEqual({ command: "pnpm run build", exitCode: 2, output: "token ***" });
    expect(failureInfo(new BuildFailedError("failed", "log hunter2"), redact)).toEqual({
      command: "Workers Builds",
      exitCode: null,
      output: "failed",
      cloudflareLog: "log ***",
    });
  });

  it("leaves Switchyard's own errors alone", () => {
    expect(failureInfo(new Error("The Worker wasn't found"), redact)).toBeNull();
  });
});

// A clone with an origin, so convert's reset to origin/main works as it does for real.
async function clone(): Promise<{ work: string; repoDir: string }> {
  const work = await makeTempDir();
  const origin = join(work, "origin");
  await mkdir(origin);
  await git(origin, "init", "-q", "-b", "main");
  await writeFile(join(origin, "package.json"), '{"name":"shop"}\n');
  await writeFile(join(origin, ".gitignore"), ".dev.vars\n");
  await git(origin, "add", "-A");
  await git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const repoDir = join(work, "work", "job");
  await mkdir(join(work, "work"), { recursive: true });
  await run("git", ["clone", "-q", origin, repoDir]);
  return { work, repoDir };
}

function fakeAgent(act: (req: AgentRequest) => Promise<void>, status: Partial<AgentStatus> = {}) {
  const requests: AgentRequest[] = [];
  const driver: AgentDriver = {
    id: "claude",
    status: async () => ({ id: "claude", installed: true, signedIn: true, detail: "Signed in", ...status }),
    run: async (req) => {
      requests.push(req);
      await act(req);
      return { verdict: "fixed", summary: "added the missing export", message: "", events: "{}", exitCode: 0, timedOut: false };
    },
  };
  return { agents: { claude: driver, codex: driver } as AgentDrivers, requests };
}

async function setup(act: (req: AgentRequest) => Promise<void>, status: Partial<AgentStatus> = {}) {
  const { work, repoDir } = await clone();
  const store = createJobStore(join(work, "jobs"));
  const created = await store.create({ ...samplePlan, agent: { id: "claude", model: "opus" } }, "acc", {});
  const job: Job = {
    ...created,
    steps: created.steps.map((s) => (s.id === "clone" ? { ...s, status: "done", outputs: { dir: repoDir } } : s)),
  };
  await store.appendLog(job.id, "[build] > vite build");
  await store.appendLog(job.id, "[convert] unrelated line");
  const { agents, requests } = fakeAgent(act, status);
  const recover = createRecovery({
    agents,
    store,
    redactor: createRedactor(),
    pipeline: { run, workDir: join(work, "work") } as unknown as PipelineDeps,
    now: () => new Date("2026-10-26T01:00:00.000Z"),
  });
  const logs: string[] = [];
  const request = (step: "build" | "convert") => ({
    job,
    step,
    failure: { command: "pnpm run build", exitCode: 1, output: "MISSING_EXPORT foo" },
    values: {},
    attempt: 1,
    previous: [],
    log: (l: string) => logs.push(l),
  });
  return { recover, request, requests, logs, repoDir, store, job };
}

describe("createRecovery", () => {
  it("runs the agent on the converted tree and records what it changed", async () => {
    const s = await setup(async (req) => {
      await writeFile(join(req.cwd, "vite.config.ts"), "export default {}\n");
    });
    await writeFile(join(s.repoDir, "cloudflare.config.ts"), "// converted\n");
    const result = await s.recover(s.request("build"));
    expect(result).toEqual({
      recovered: true,
      run: {
        step: "build",
        agent: "claude",
        model: "opus",
        attempt: 1,
        startedAt: "2026-10-26T01:00:00.000Z",
        verdict: "fixed",
        summary: "added the missing export",
        changedFiles: ["vite.config.ts"],
      },
    });
    const req = s.requests[0]!;
    expect(req.cwd).toBe(s.repoDir);
    expect(req.model).toBe("opus");
    expect(req.prompt).toContain("MISSING_EXPORT foo");
    expect(req.prompt).toContain("> vite build");
    expect(req.prompt).not.toContain("unrelated line");
    expect(existsSync(join(s.repoDir, "cloudflare.config.ts"))).toBe(true);
    expect(s.logs[0]).toBe("Agent: asking Claude to fix this (attempt 1 of 2)");
    expect(existsSync(s.store.agentEventsFile(s.job.id, "build", 1))).toBe(true);
  });

  it("gives a convert recovery a clean checkout and commits the agent's fix", async () => {
    const s = await setup(async (req) => {
      expect(existsSync(join(req.cwd, "half-converted.ts"))).toBe(false);
      await writeFile(join(req.cwd, ".npmrc"), "legacy-peer-deps=true\n");
    });
    await writeFile(join(s.repoDir, "half-converted.ts"), "x\n");
    const result = await s.recover(s.request("convert"));
    expect(result.recovered).toBe(true);
    const head = (await git(s.repoDir, "rev-parse", "HEAD")).stdout.trim();
    expect(result.run?.fixCommit).toBe(head);
    expect(await readFile(join(s.repoDir, ".npmrc"), "utf8")).toBe("legacy-peer-deps=true\n");
    expect((await git(s.repoDir, "log", "-1", "--format=%s")).stdout.trim()).toBe(
      "fix: changes by Claude so the Cloudflare conversion succeeds",
    );
  });

  it("explains when the agent isn't signed in, without running it", async () => {
    const s = await setup(async () => {}, { signedIn: false, detail: "Not signed in: run claude, then /login" });
    expect(await s.recover(s.request("build"))).toEqual({
      recovered: false,
      run: null,
      note: "Claude couldn't be asked to fix it: Not signed in: run claude, then /login.",
    });
    expect(s.requests).toEqual([]);
  });
});
