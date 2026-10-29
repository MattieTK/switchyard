import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelResponse, OpenAIClient, ResponseRequest } from "../../src/clients/openai.ts";
import type { RunResult } from "../../src/exec.ts";
import { ApiError } from "../../src/http.ts";
import { migrationContext, repairWarning, repairWithAI, type RepairTask } from "../../src/pipeline/ai-repair.ts";
import { fakeRunner } from "../helpers/fake-runner.ts";
import { makeContext } from "../helpers/step-context.ts";
import { makeTempDir } from "../helpers/tmp.ts";

type Call = [name: string, args: Record<string, unknown>];

// A model that makes the given tool calls, one list per turn.
function scriptedModel(turns: (Call[] | string)[]) {
  const requests: ResponseRequest[] = [];
  let n = 0;
  const client: OpenAIClient = {
    listModels: async () => ["gpt-5.5"],
    async respond(req) {
      requests.push(structuredClone(req));
      const turn = turns[n++] ?? [["finish", { fixed: false, summary: "Out of script." }]];
      const output: ModelResponse["output"] =
        typeof turn === "string"
          ? [{ type: "message", content: [{ type: "output_text", text: turn }] }]
          : turn.map(([name, args], i) => ({ type: "function_call", id: `fc_${n}_${i}`, call_id: `c${n}-${i}`, name, arguments: JSON.stringify(args) }));
      return { id: `resp_${n}`, output };
    },
  };
  return { client, requests };
}

// The results of the tool calls a request reports back.
const outputsOf = (req: ResponseRequest | undefined) =>
  (req?.input ?? []).flatMap((i) => ("output" in i && typeof i.output === "string" ? [i.output] : []));

const ok: RunResult = { code: 0, output: "Build complete", stdout: "" };
const failing: RunResult = { code: 1, output: "error TS2307: Cannot find module './Header'", stdout: "" };

async function setup(turns: (Call[] | string)[], o: { aiRepair?: boolean; verify?: () => Promise<RunResult> } = {}) {
  const repoDir = await makeTempDir();
  await mkdir(join(repoDir, "app"), { recursive: true });
  await writeFile(join(repoDir, "app", "page.tsx"), 'import Header from "./Header";\n');
  await writeFile(join(repoDir, "app", "header.tsx"), "export default function Header() {}\n");
  const model = scriptedModel(turns);
  const verify = vi.fn(o.verify ?? (async () => ok));
  const { ctx, logs } = makeContext({
    plan: { options: { adoptionCodemods: false, eslintMigration: false, updateFlaggedPackages: false, switchToPnpm: false, aiRepair: o.aiRepair ?? true } },
    deps: { openai: async () => ({ client: model.client, model: "gpt-5.5" }) },
    outputs: { clone: { dir: repoDir } },
  });
  const task: RepairTask = { what: "the local build", output: failing.output, projectDir: repoDir, verify };
  return { ctx, logs, task, verify, repoDir, ...model };
}

const fix: Call[] = [["replace_in_file", { path: "app/page.tsx", old_text: '"./Header"', new_text: '"./header"' }]];

describe("repairWithAI", () => {
  it("does nothing unless the plan opted in", async () => {
    const { ctx, task, requests } = await setup([], { aiRepair: false });
    expect(await repairWithAI(ctx, task)).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("says so when OpenAI was disconnected after the plan was approved", async () => {
    const { ctx, task, logs } = await setup([]);
    ctx.deps.openai = async () => null;
    expect(await repairWithAI(ctx, task)).toBeNull();
    expect(logs.join("\n")).toContain("OpenAI isn't connected any more");
  });

  it("lets the model read and edit files, checks the fix and reports what changed", async () => {
    const { ctx, task, verify, repoDir, requests } = await setup([
      [["read_file", { path: "app/page.tsx" }]],
      fix,
      [["run_check", {}]],
      [["finish", { fixed: true, summary: "The import used the wrong letter case." }]],
    ]);
    const result = await repairWithAI(ctx, task);
    expect(result).toMatchObject({ fixed: true, model: "gpt-5.5", changed: ["app/page.tsx"], passed: ok });
    expect(await readFile(join(repoDir, "app", "page.tsx"), "utf8")).toBe('import Header from "./header";\n');
    expect(verify).toHaveBeenCalledTimes(1);

    expect(requests[0]?.input).toEqual([{ role: "user", content: expect.stringContaining("Cannot find module './Header'") }]);
    expect(requests[0]?.tools?.map((t) => t.name)).toContain("run_check");
    // Each request carries the conversation so far, without stored item ids.
    expect(requests[1]?.input.slice(1)).toEqual([
      { type: "function_call", call_id: "c1-0", name: "read_file", arguments: '{"path":"app/page.tsx"}' },
      { type: "function_call_output", call_id: "c1-0", output: 'import Header from "./Header";\n' },
    ]);
    expect(requests[3]?.input).toHaveLength(7);
    expect(repairWarning(result!, "the local build")).toBe(
      "The local build failed, and OpenAI (gpt-5.5) fixed it: The import used the wrong letter case. It changed app/page.tsx. Review these changes before merging.",
    );
  });

  it("runs the check itself when the model finishes without one, and keeps going when it fails", async () => {
    const results = [failing, ok];
    const { ctx, task, verify, requests } = await setup(
      [
        [...fix, ["finish", { fixed: true, summary: "Fixed the import." }]],
        [["write_file", { path: "app/extra.ts", content: "export {};\n" }], ["finish", { fixed: true, summary: "Fixed it." }]],
      ],
      { verify: async () => results.shift() ?? ok },
    );
    const result = await repairWithAI(ctx, task);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(requests[1]?.input).toContainEqual(
      expect.objectContaining({ call_id: "c1-1", output: expect.stringContaining("still fails") }),
    );
    expect(result).toMatchObject({ fixed: true, summary: "Fixed it.", changed: ["app/page.tsx", "app/extra.ts"] });
  });

  it("reports the model's reason when it can't fix the code", async () => {
    const { ctx, task } = await setup([[["finish", { fixed: false, summary: "The Cloudflare token expired." }]]]);
    expect(await repairWithAI(ctx, task)).toMatchObject({ fixed: false, summary: "The Cloudflare token expired." });
  });

  it("treats a reply without tool calls as giving up", async () => {
    const { ctx, task } = await setup(["I can't tell what's wrong."]);
    expect(await repairWithAI(ctx, task)).toMatchObject({ fixed: false, summary: "I can't tell what's wrong." });
  });

  it("keeps the model inside the working copy and away from secrets", async () => {
    const outside = await makeTempDir();
    const { ctx, task, repoDir, requests } = await setup([
      [
        ["read_file", { path: "../outside.txt" }],
        ["read_file", { path: ".env.local" }],
        ["read_file", { path: "app/.dev.vars" }],
        ["write_file", { path: ".git/config", content: "x" }],
        ["write_file", { path: "node_modules/x/index.js", content: "x" }],
        ["read_file", { path: "linked/secret.txt" }],
        ["add_packages", { packages: ["--registry=https://evil.example"], dev: false }],
        ["no_such_tool", {}],
      ],
    ]);
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(repoDir, "linked"));
    await repairWithAI(ctx, task);
    expect(outputsOf(requests[1])).toEqual([
      "Error: ../outside.txt is outside the repository.",
      "Error: .env.local holds secret values, which you can't read or change.",
      "Error: app/.dev.vars holds secret values, which you can't read or change.",
      "Error: The .git folder is off limits.",
      "Error: Files in node_modules can't be changed.",
      "Error: linked/secret.txt leads outside the repository.",
      "Error: Not package names: --registry=https://evil.example.",
      "Error: there is no tool called no_such_tool.",
    ]);
  });

  it("hides secret values from the model and won't overwrite a file that holds them", async () => {
    const { ctx, task, repoDir, requests } = await setup([
      [
        ["read_file", { path: "config.ts" }],
        ["write_file", { path: "config.ts", content: "export const key = '***';\n" }],
      ],
    ]);
    ctx.addSecret("sk-live-1234");
    await writeFile(join(repoDir, "config.ts"), "export const key = 'sk-live-1234';\n");
    await repairWithAI(ctx, { ...task, output: "failed with sk-live-1234" });
    expect(JSON.stringify(requests[0]?.input)).toContain("failed with ***");
    const outputs = outputsOf(requests[1]);
    expect(outputs[0]).toBe("export const key = '***';\n");
    expect(outputs[1]).toContain("contains secret values");
    expect(await readFile(join(repoDir, "config.ts"), "utf8")).toContain("sk-live-1234");
  });

  it("adds packages with the project's package manager", async () => {
    const { run, calls } = fakeRunner();
    const { ctx, task } = await setup([[["add_packages", { packages: ["zod@^4"], dev: true }]]]);
    ctx.deps.run = run;
    await repairWithAI(ctx, task);
    expect(calls[0]).toMatchObject({ cmd: "pnpm", args: ["add", "-D", "zod@^4"] });
  });

  it("stops after a limited number of checks", async () => {
    const { ctx, task, verify } = await setup(Array.from({ length: 10 }, (): Call[] => [["run_check", {}]]), {
      verify: async () => failing,
    });
    await repairWithAI(ctx, task);
    expect(verify).toHaveBeenCalledTimes(6);
  });

  it("logs OpenAI's own errors and leaves the original failure to the step", async () => {
    const { ctx, task, logs } = await setup([]);
    ctx.deps.openai = async () => ({
      model: "gpt-5.5",
      client: {
        listModels: async () => [],
        respond: async () => {
          throw new ApiError("openai", 429, "You exceeded your current quota");
        },
      },
    });
    expect(await repairWithAI(ctx, task)).toMatchObject({ fixed: false });
    expect(logs.join("\n")).toContain("OpenAI couldn't help: openai API error 429: You exceeded your current quota");
  });

  it("tells the model a plan that didn't opt in can sign in, or select Fix with AI", async () => {
    const { ctx, task, logs, requests } = await setup([], { aiRepair: false });
    ctx.deps.openai = async () => null;
    await repairWithAI(ctx, task);
    expect(logs.at(-1)).toBe("Sign in with ChatGPT on the Connect page to have OpenAI try to fix this, then select Fix with AI.");
    const connected = await setup([], { aiRepair: false });
    await repairWithAI(connected.ctx, connected.task);
    expect(connected.logs.at(-1)).toBe("Select Fix with AI on this page to have OpenAI try to fix this.");
    expect(requests).toHaveLength(0);
  });

  it("gives the model the steps done, the one that failed, those still to run and where its fix goes", async () => {
    const { ctx, task, requests, repoDir } = await setup([[["finish", { fixed: false, summary: "No." }]]]);
    const step = (id: string) => ctx.job.steps.find((s) => s.id === id)!;
    step("clone").status = "done";
    step("convert").status = "done";
    step("build").status = "running";
    await repairWithAI(ctx, task);
    const text = requests[0]?.instructions ?? "";
    expect(text).toContain("Steps done:\n1. Clone the repository.");
    expect(text).toContain("2. Convert the project.");
    expect(text).toContain("The step that failed, which you're fixing:\n3. Build locally with cf.");
    expect(text).toContain("Steps still to run after your fix:\n4. Create the Worker with a first deploy.");
    expect(text).toContain("8. Run the first Cloudflare build.");
    expect(text).toContain(`The working copy is ${repoDir}, on the cloudflare-migration branch.`);
    expect(text).toContain("Your changes stay in this working copy until the push step commits them to cloudflare-migration");
  });
});

describe("migrationContext", () => {
  it("once the branch is pushed, says the fix becomes a new commit and names the pull request", () => {
    const { ctx } = makeContext();
    for (const s of ctx.job.steps) s.status = "done";
    const last = ctx.job.steps.at(-1)!;
    last.status = "running";
    ctx.job.steps.find((s) => s.id === "pr")!.outputs.prUrl = "https://github.com/acme/shop/pull/7";
    const text = migrationContext(ctx, "/work/job");
    expect(text).toContain("6. Open the pull request. Opens a pull request from cloudflare-migration into the production branch, listing every change to review. (pull request: https://github.com/acme/shop/pull/7)");
    expect(text).toContain("Steps still to run after your fix:\nNone. This is the last step.");
    expect(text).toContain(
      "Where your changes go: The branch is already on GitHub and the pull request is open at https://github.com/acme/shop/pull/7. Once your fix passes, Switchyard commits your changes as a new commit on cloudflare-migration, pushes it, comments on the pull request and runs this step again.",
    );
  });
});
