import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recoverWithAgent, type RecoverInput } from "../../src/agent/recover.ts";
import type { AgentDriver, AgentRequest, AgentResult } from "../../src/agent/types.ts";
import { createCommandRunner } from "../../src/exec.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const run = createCommandRunner();
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });

// A repository with one commit and some uncommitted conversion changes, like the tree the
// build step leaves behind.
async function repo(): Promise<{ repoDir: string; work: string }> {
  const work = await makeTempDir();
  const repoDir = join(work, "repo");
  await mkdir(repoDir);
  await git(repoDir, "init", "-q");
  await writeFile(join(repoDir, ".gitignore"), ".dev.vars\nnode_modules/\n");
  await writeFile(join(repoDir, "package.json"), '{"name":"app"}\n');
  await writeFile(join(repoDir, "build.js"), "require('./missing')\n");
  await git(repoDir, "add", "-A");
  await git(repoDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  await writeFile(join(repoDir, "package.json"), '{"name":"app","type":"module"}\n');
  await writeFile(join(repoDir, "vite.config.ts"), "export default {}\n");
  await writeFile(join(repoDir, ".dev.vars"), "SECRET=dev-value\n");
  return { repoDir, work };
}

const result = (over: Partial<AgentResult> = {}): AgentResult => ({
  verdict: "fixed",
  summary: "fixed the import",
  message: "Done.",
  events: '{"type":"done"}\n',
  exitCode: 0,
  timedOut: false,
  ...over,
});

function driver(act: (req: AgentRequest) => Promise<AgentResult | void>): AgentDriver & { requests: AgentRequest[] } {
  const requests: AgentRequest[] = [];
  return {
    id: "claude",
    requests,
    status: async () => ({ id: "claude", installed: true, signedIn: true, detail: "" }),
    run: async (req) => {
      requests.push(req);
      return (await act(req)) ?? result();
    },
  };
}

function input(r: { repoDir: string; work: string }, d: AgentDriver, over: Partial<RecoverInput> = {}): RecoverInput {
  return {
    driver: d,
    run,
    repoDir: r.repoDir,
    projectDir: r.repoDir,
    prompt: "fix it",
    writableDirs: [],
    protectedPaths: ["/config/switchyard"],
    heldDevVarsPath: join(r.work, "job.dev.vars.held"),
    scratchDir: r.work,
    eventsPath: join(r.work, "job.agent-build-1.jsonl"),
    redact: (t) => t.replaceAll("dev-value", "***"),
    log: () => {},
    timeoutMs: 15 * 60_000,
    ...over,
  };
}

describe("recoverWithAgent", () => {
  it("lists exactly the files the agent changed, including ones the conversion had already changed", async () => {
    const r = await repo();
    const d = driver(async (req) => {
      await writeFile(join(req.cwd, "build.js"), "console.log('ok')\n");
      await writeFile(join(req.cwd, "vite.config.ts"), "export default { ssr: {} }\n");
      await writeFile(join(req.cwd, "lib.js"), "export {}\n");
    });
    const outcome = await recoverWithAgent(input(r, d));
    expect(outcome).toEqual({ verdict: "fixed", summary: "fixed the import", message: "Done.", changedFiles: ["build.js", "lib.js", "vite.config.ts"] });
    expect(d.requests[0]).toMatchObject({ cwd: r.repoDir, prompt: "fix it" });
  });

  it("hides .dev.vars while the agent runs and puts it back, even when the agent throws", async () => {
    const r = await repo();
    let seen: boolean | null = null;
    const d = driver(async (req) => {
      seen = existsSync(join(req.cwd, ".dev.vars"));
      throw new Error("crashed");
    });
    await expect(recoverWithAgent(input(r, d))).rejects.toThrow("crashed");
    expect(seen).toBe(false);
    expect(await readFile(join(r.repoDir, ".dev.vars"), "utf8")).toBe("SECRET=dev-value\n");
    expect(existsSync(join(r.work, "job.dev.vars.held"))).toBe(false);
  });

  it("puts back a .dev.vars an interrupted run left outside the project", async () => {
    const r = await repo();
    const held = join(r.work, "job.dev.vars.held");
    await writeFile(held, "SECRET=older\n");
    await rm(join(r.repoDir, ".dev.vars"));
    await recoverWithAgent(input(r, driver(async () => {})));
    expect(await readFile(join(r.repoDir, ".dev.vars"), "utf8")).toBe("SECRET=older\n");
  });

  it("reports an agent that changed nothing Switchyard can keep", async () => {
    const r = await repo();
    const d = driver(async (req) => {
      await mkdir(join(req.cwd, "node_modules"), { recursive: true });
      await writeFile(join(req.cwd, "node_modules", "patched.js"), "x");
    });
    const outcome = await recoverWithAgent(input(r, d));
    expect(outcome.changedFiles).toEqual([]);
    expect(outcome.error).toBe("Claude made no changes Switchyard can keep. It said: fixed the import");
  });

  it("passes on the agent's reason when it can't fix the failure", async () => {
    const r = await repo();
    const outcome = await recoverWithAgent(
      input(r, driver(async () => result({ verdict: "cannot-fix", summary: "the build needs a Supabase key" }))),
    );
    expect(outcome.error).toBe("Claude couldn't fix it: the build needs a Supabase key");
  });

  it("puts the tree back as it was when the agent's work is turned down", async () => {
    const r = await repo();
    const d = driver(async (req) => {
      await writeFile(join(req.cwd, "vite.config.ts"), "broken\n");
      await writeFile(join(req.cwd, "build.js"), "half done\n");
      await writeFile(join(req.cwd, "scratch.js"), "x\n");
      return result({ verdict: "cannot-fix", summary: "needs a key" });
    });
    const outcome = await recoverWithAgent(input(r, d));
    expect(outcome.changedFiles).toEqual(["build.js", "scratch.js", "vite.config.ts"]);
    expect(await readFile(join(r.repoDir, "vite.config.ts"), "utf8")).toBe("export default {}\n");
    expect(await readFile(join(r.repoDir, "build.js"), "utf8")).toBe("require('./missing')\n");
    expect(await readFile(join(r.repoDir, "package.json"), "utf8")).toBe('{"name":"app","type":"module"}\n');
    expect(existsSync(join(r.repoDir, "scratch.js"))).toBe(false);
    expect(await readFile(join(r.repoDir, ".dev.vars"), "utf8")).toBe("SECRET=dev-value\n");
  });

  it("says when the agent ran out of time or stopped", async () => {
    const r = await repo();
    const late = await recoverWithAgent(input(r, driver(async () => result({ timedOut: true, exitCode: 143, verdict: "no-verdict" }))));
    expect(late.error).toBe("Claude didn't finish within 15 minutes.");
    const stopped = await recoverWithAgent(
      input(r, driver(async () => result({ exitCode: 1, verdict: "no-verdict", summary: "", message: "usage limit reached" }))),
    );
    expect(stopped.error).toBe("Claude stopped with exit code 1: usage limit reached");
  });

  it("commits the changes for the conversion's fix layer", async () => {
    const r = await repo();
    await git(r.repoDir, "reset", "--hard", "-q");
    await git(r.repoDir, "clean", "-fdq");
    const d = driver(async (req) => {
      await writeFile(join(req.cwd, "build.js"), "console.log('ok')\n");
    });
    const outcome = await recoverWithAgent(input(r, d, { commitAs: { agentLabel: "Claude" } }));
    const head = (await git(r.repoDir, "rev-parse", "HEAD")).stdout.trim();
    expect(outcome.fixCommit).toBe(head);
    expect((await git(r.repoDir, "log", "-1", "--format=%s")).stdout.trim()).toBe(
      "fix: changes by Claude so the Cloudflare conversion succeeds",
    );
    expect((await git(r.repoDir, "status", "--porcelain")).stdout.trim()).toBe("");
  });

  it("saves the event stream with secrets redacted", async () => {
    const r = await repo();
    const d = driver(async (req) => {
      await writeFile(join(req.cwd, "build.js"), "ok\n");
      return result({ events: '{"text":"SECRET=dev-value"}\n' });
    });
    await recoverWithAgent(input(r, d));
    expect(await readFile(join(r.work, "job.agent-build-1.jsonl"), "utf8")).toBe('{"text":"SECRET=***"}\n');
  });

  it("undoes a rename and lists both paths, including names outside ASCII", async () => {
    const r = await repo();
    const d = driver(async (req) => {
      const { rename } = await import("node:fs/promises");
      await rename(join(req.cwd, "build.js"), join(req.cwd, "build.cjs"));
      await writeFile(join(req.cwd, "café.tsx"), "x\n");
      return result({ verdict: "cannot-fix", summary: "gave up" });
    });
    const outcome = await recoverWithAgent(input(r, d));
    expect(outcome.changedFiles).toEqual(["build.cjs", "build.js", "café.tsx"]);
    expect(existsSync(join(r.repoDir, "build.cjs"))).toBe(false);
    expect(existsSync(join(r.repoDir, "café.tsx"))).toBe(false);
    expect(await readFile(join(r.repoDir, "build.js"), "utf8")).toBe("require('./missing')\n");
  });

  it("keeps .dev.vars and node_modules out of the fix commit when the project doesn't ignore them yet", async () => {
    const r = await repo();
    await writeFile(join(r.repoDir, ".gitignore"), "");
    await git(r.repoDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "stop ignoring");
    await git(r.repoDir, "reset", "--hard", "-q");
    await git(r.repoDir, "clean", "-fdxq");
    // An interrupted run on another step left development values outside the project.
    await writeFile(join(r.work, "job.dev.vars.held"), "SECRET=dev-value\n");
    const d = driver(async (req) => {
      await mkdir(join(req.cwd, "node_modules", "left-pad"), { recursive: true });
      await writeFile(join(req.cwd, "node_modules", "left-pad", "index.js"), "x\n");
      await writeFile(join(req.cwd, ".npmrc"), "legacy-peer-deps=true\n");
    });
    const outcome = await recoverWithAgent(input(r, d, { commitAs: { agentLabel: "Claude" } }));
    expect(outcome.changedFiles).toEqual([".npmrc"]);
    const committed = (await git(r.repoDir, "show", "--name-only", "--format=", "HEAD")).stdout.trim().split("\n");
    expect(committed).toEqual([".npmrc"]);
    expect(existsSync(join(r.repoDir, ".dev.vars"))).toBe(false);
    expect(existsSync(join(r.work, "job.dev.vars.held"))).toBe(false);
  });

  it("works in a project folder below the repository root", async () => {
    const r = await repo();
    await mkdir(join(r.repoDir, "web"));
    const d = driver(async (req) => {
      await writeFile(join(req.cwd, "page.tsx"), "x\n");
    });
    const outcome = await recoverWithAgent(input(r, d, { projectDir: join(r.repoDir, "web") }));
    expect(outcome.changedFiles).toEqual(["web/page.tsx"]);
  });
});
