import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BuildInfo, CloudflareClient, TriggerInput } from "../../../src/clients/cloudflare.ts";
import type { GitHubClient } from "../../../src/clients/github.ts";
import type { ResponseRequest } from "../../../src/clients/openai.ts";
import { ApiError } from "../../../src/http.ts";
import { buildsStep, buildTokenFormUrl, PREVIEW_DEPLOY_COMMAND, startBuildStep } from "../../../src/pipeline/steps/builds.ts";
import { STEPS } from "../../../src/pipeline/steps/index.ts";
import { PauseError, STEP_IDS } from "../../../src/pipeline/types.ts";
import { buildEnvPlan } from "../../../src/translate/env-plan.ts";
import { fakeRunner } from "../../helpers/fake-runner.ts";
import { makeContext } from "../../helpers/step-context.ts";
import { makeTempDir } from "../../helpers/tmp.ts";

const github = {
  getRepo: async () => ({ id: 22, name: "shop", ownerId: 11, ownerLogin: "acme", defaultBranch: "main", private: true }),
} as unknown as GitHubClient;

function cloudflare(over: Partial<CloudflareClient> = {}) {
  const created: TriggerInput[] = [];
  const envCalls: [string, Record<string, unknown>][] = [];
  const cf = {
    putRepoConnection: vi.fn(async () => "rc-1"),
    listBuildTokens: async () => [{ build_token_uuid: "bt-1", build_token_name: "Workers Builds" }],
    listTriggers: async () => [],
    createTrigger: async (_a: string, input: TriggerInput) => {
      created.push(input);
      return { trigger_uuid: `tr-${created.length}`, trigger_name: input.trigger_name };
    },
    setTriggerEnv: async (_a: string, uuid: string, vars: Record<string, unknown>) => {
      envCalls.push([uuid, vars]);
    },
    ...over,
  } as unknown as CloudflareClient;
  return { cf, created, envCalls };
}

const { plan: env, values } = buildEnvPlan(
  [
    { id: "p", key: "API_KEY", value: "prod", type: "encrypted", decrypted: true, target: ["production"] },
    { id: "v", key: "API_KEY", value: "prev", type: "encrypted", decrypted: true, target: ["preview"] },
  ],
  [],
);

describe("buildsStep", () => {
  it("connects the repo and creates production and preview triggers with build variables", async () => {
    const { cf, created, envCalls } = cloudflare();
    const { ctx } = makeContext({
      plan: { env, repo: { owner: "acme", name: "shop", productionBranch: "main", rootDirectory: "apps/web" } },
      values,
      deps: { cloudflare: cf, github: async () => github },
      outputs: { deploy: { workerTag: "tag-1" } },
    });
    await buildsStep.run(ctx);

    expect(cf.putRepoConnection).toHaveBeenCalledWith("acc", {
      provider_type: "github",
      provider_account_id: "11",
      provider_account_name: "acme",
      repo_id: "22",
      repo_name: "shop",
    });
    expect(created[0]).toMatchObject({
      external_script_id: "tag-1",
      repo_connection_uuid: "rc-1",
      build_token_uuid: "bt-1",
      trigger_name: "switchyard-production",
      build_command: "pnpm exec cf build",
      deploy_command: "pnpm exec cf deploy --prebuilt",
      root_directory: "/apps/web",
      branch_includes: ["main"],
      branch_excludes: [],
    });
    expect(created[1]).toMatchObject({
      trigger_name: "switchyard-preview",
      deploy_command: PREVIEW_DEPLOY_COMMAND,
      branch_includes: ["*"],
      branch_excludes: ["main"],
    });
    expect(envCalls).toEqual([
      ["tr-1", { API_KEY: { value: "prod", is_secret: true } }],
      ["tr-2", { API_KEY: { value: "prev", is_secret: true } }],
    ]);
    expect(ctx.outputs).toEqual({ productionTrigger: "tr-1", previewTrigger: "tr-2" });
  });

  it("builds with the build:cloudflare script when the conversion added one", async () => {
    const { cf, created } = cloudflare();
    const { ctx } = makeContext({
      deps: { cloudflare: cf, github: async () => github },
      outputs: { deploy: { workerTag: "tag-1" }, convert: { buildScript: "build:cloudflare" } },
    });
    await buildsStep.run(ctx);
    expect(created.map((t) => t.build_command)).toEqual(["pnpm run build:cloudflare", "pnpm run build:cloudflare"]);
    expect(created[0]?.deploy_command).toBe("pnpm exec cf deploy --prebuilt");
  });

  it("reuses triggers that already exist", async () => {
    const { cf, created } = cloudflare({
      listTriggers: async () => [
        { trigger_uuid: "old-1", trigger_name: "switchyard-production" },
        { trigger_uuid: "old-2", trigger_name: "switchyard-preview" },
      ],
    });
    const { ctx } = makeContext({ deps: { cloudflare: cf, github: async () => github }, outputs: { deploy: { workerTag: "t" } } });
    await buildsStep.run(ctx);
    expect(created).toEqual([]);
    expect(ctx.outputs).toEqual({ productionTrigger: "old-1", previewTrigger: "old-2" });
  });

  it("points existing triggers at the build token when they use another one", async () => {
    // A trigger keeps a deleted build token until it's repointed, and its builds fail.
    const setTriggerBuildToken = vi.fn(async () => {});
    const { cf } = cloudflare({
      listTriggers: async () => [
        { trigger_uuid: "old-1", trigger_name: "switchyard-production", build_token_uuid: "gone" },
        { trigger_uuid: "old-2", trigger_name: "switchyard-preview", build_token_uuid: "bt-1" },
      ],
      setTriggerBuildToken,
    });
    const { ctx } = makeContext({ deps: { cloudflare: cf, github: async () => github }, outputs: { deploy: { workerTag: "t" } } });
    await buildsStep.run(ctx);
    expect(setTriggerBuildToken.mock.calls).toEqual([["acc", "old-1", "bt-1"]]);
  });

  it("pauses with the dashboard steps that connect GitHub when Cloudflare can't see the repo", async () => {
    const { cf } = cloudflare({
      putRepoConnection: async () => {
        throw new ApiError("cloudflare", 400, "repository not accessible");
      },
    });
    const { ctx } = makeContext({ deps: { cloudflare: cf, github: async () => github }, outputs: { deploy: { workerTag: "t" } } });
    const err = await buildsStep.run(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PauseError);
    // Installing the GitHub App from GitHub alone doesn't link it to the Cloudflare account.
    expect((err as PauseError).pause.actionUrl).toBe("https://dash.cloudflare.com/acc/workers-and-pages");
    expect((err as PauseError).pause.reason).toContain("+ Add account");
  });

  it("asks for a user API token, with the token form filled in, when the user has no build token", async () => {
    // Build tokens belong to a user, so one made by another member of the account isn't listed.
    const { cf } = cloudflare({ listBuildTokens: async () => [], getUser: async () => ({ id: "u", email: "me@example.com" }) });
    const { ctx } = makeContext({ deps: { cloudflare: cf, github: async () => github }, outputs: { deploy: { workerTag: "t" } } });
    const err = await buildsStep.run(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PauseError);
    const { pause } = err as PauseError;
    expect(pause.input).toBe("cloudflare-build-token");
    expect(pause.actionUrl).toBe(buildTokenFormUrl("acc"));
    expect(pause.reason).toContain("signed in as me@example.com");

    const url = new URL(buildTokenFormUrl("acc"));
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(url.searchParams.get("accountId")).toBe("acc");
    expect(url.searchParams.get("name")).toBe("Switchyard");
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "[]")).toContainEqual({ key: "workers_ci", type: "edit" });

    // Without the user's details the message still says whose token it must be.
    const failing = cloudflare({
      listBuildTokens: async () => [],
      getUser: async () => {
        throw new Error("no access");
      },
    });
    const second = makeContext({ deps: { cloudflare: failing.cf, github: async () => github }, outputs: { deploy: { workerTag: "t" } } });
    const err2 = await buildsStep.run(second.ctx).catch((e: unknown) => e);
    expect((err2 as PauseError).pause.reason).toContain("the Cloudflare user you connected Switchyard with");
  });
});

describe("startBuildStep", () => {
  function withBuilds(states: BuildInfo[], now: () => number = () => 0) {
    const cf = {
      startBuild: vi.fn(async () => "b-1"),
      getBuild: vi.fn(async () => states.shift() ?? { build_uuid: "b-1", status: "running" }),
    } as unknown as CloudflareClient;
    return makeContext({ deps: { cloudflare: cf, now }, outputs: { builds: { previewTrigger: "tr-2" } } });
  }

  it("starts a build of the migration branch and waits for success", async () => {
    const { ctx, logs } = withBuilds([
      { build_uuid: "b-1", status: "queued" },
      { build_uuid: "b-1", status: "running" },
      { build_uuid: "b-1", status: "stopped", build_outcome: "success" },
    ]);
    await startBuildStep.run(ctx);
    expect(ctx.deps.cloudflare.startBuild).toHaveBeenCalledWith("acc", "tr-2", "cloudflare-migration");
    expect(ctx.outputs.buildUuid).toBe("b-1");
    expect(ctx.outputs.buildUrl).toContain("/builds/b-1");
    expect(logs.filter((l) => l.startsWith("Build status"))).toHaveLength(3);
  });

  it("fails with a link to the build log when the build fails", async () => {
    const { ctx } = withBuilds([{ build_uuid: "b-1", status: "stopped", build_outcome: "fail" }]);
    await expect(startBuildStep.run(ctx)).rejects.toThrow(/finished with "fail".*builds\/b-1/);
  });

  it("lets OpenAI fix a failed Cloudflare build from its log, pushes the fix and builds again", async () => {
    const repoDir = await makeTempDir();
    await writeFile(join(repoDir, ".nvmrc"), "18\n");
    const states: BuildInfo[] = [
      { build_uuid: "b-1", status: "stopped", build_outcome: "fail" },
      { build_uuid: "b-2", status: "stopped", build_outcome: "success" },
    ];
    const cf = {
      startBuild: vi.fn(async () => (states.length === 2 ? "b-1" : "b-2")),
      getBuild: vi.fn(async () => states.shift()),
      getBuildLog: vi.fn(async () => ["Installing Node.js 18", "cf requires Node.js 22 or later"]),
    } as unknown as CloudflareClient;
    const gh = {
      findOpenPr: async () => ({ url: "https://github.com/acme/shop/pull/7", number: 7 }),
      commentOnPr: vi.fn(async () => {}),
    } as unknown as GitHubClient;
    const { run, calls } = fakeRunner();
    const turns = [
      [{ name: "write_file", args: { path: ".nvmrc", content: "22\n" } }],
      [{ name: "finish", args: { fixed: true, summary: "Raised .nvmrc to Node.js 22." } }],
    ];
    const respond = vi.fn(async (req: ResponseRequest) => {
      expect(JSON.stringify(req.input[0])).toContain("cf requires Node.js 22 or later");
      return {
        id: "r",
        output: (turns.shift() ?? []).map((c, i) => ({ type: "function_call", call_id: `c${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
      };
    });
    const { ctx } = makeContext({
      plan: { options: { adoptionCodemods: false, eslintMigration: false, updateFlaggedPackages: false, switchToPnpm: false, aiRepair: true } },
      deps: { cloudflare: cf, run, github: async () => gh, openai: async () => ({ model: "gpt-5.5", client: { listModels: async () => [], respond } }) },
      outputs: { clone: { dir: repoDir }, convert: { projectDir: repoDir }, builds: { previewTrigger: "tr-2" } },
    });
    // git status reports the change, so it's committed.
    ctx.deps.run = async (cmd, args, opts) =>
      cmd === "git" && args[0] === "status" ? { code: 0, output: " M .nvmrc", stdout: " M .nvmrc" } : run(cmd, args, opts);

    await startBuildStep.run(ctx);
    expect(await readFile(join(repoDir, ".nvmrc"), "utf8")).toBe("22\n");
    // Checked with a clean install and the build, as Workers Builds runs them.
    expect(calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual(
      expect.arrayContaining(["pnpm install", "pnpm exec cf build", "git push --force origin HEAD:refs/heads/cloudflare-migration"]),
    );
    expect(calls.find((c) => c.args.includes("commit"))?.args).toContain("OpenAI (gpt-5.5): Raised .nvmrc to Node.js 22.");
    expect(gh.commentOnPr).toHaveBeenCalledWith("acme", "shop", 7, expect.stringContaining("Raised .nvmrc to Node.js 22."));
    expect(cf.startBuild).toHaveBeenCalledTimes(2);
    expect(ctx.outputs.buildUuid).toBe("b-2");
  });

  it("starts from the failed build's log when Fix with AI retries the step, and says so when OpenAI can't fix it", async () => {
    const cf = {
      startBuild: vi.fn(),
      getBuildLog: vi.fn(async () => ["npm ERR! missing script: build:cloudflare"]),
    } as unknown as CloudflareClient;
    const respond = vi.fn(async () => ({
      id: "r",
      output: [{ type: "function_call", call_id: "c", name: "finish", arguments: JSON.stringify({ fixed: false, summary: "Unclear." }) }],
    }));
    const { ctx } = makeContext({
      plan: { options: { adoptionCodemods: false, eslintMigration: false, updateFlaggedPackages: false, switchToPnpm: false, aiRepair: true } },
      deps: { cloudflare: cf, openai: async () => ({ model: "gpt-5.5", client: { listModels: async () => [], respond } }) },
      outputs: { clone: { dir: await makeTempDir() }, convert: { projectDir: "/w" }, builds: { previewTrigger: "tr-2" } },
    });
    ctx.outputs.failedBuild = "b-1";
    await expect(startBuildStep.run(ctx)).rejects.toThrow(/OpenAI didn't fix the Cloudflare build.*builds\/b-1/);
    expect(cf.getBuildLog).toHaveBeenCalledWith("acc", "b-1");
    expect(cf.startBuild).not.toHaveBeenCalled();
    expect(ctx.outputs.failedBuild).toBeUndefined();
  });

  it("doesn't ask OpenAI about a failed Cloudflare build unless the plan opted in", async () => {
    const getBuildLog = vi.fn();
    const cf = {
      startBuild: async () => "b-1",
      getBuild: async () => ({ build_uuid: "b-1", status: "stopped", build_outcome: "fail" }),
      getBuildLog,
    } as unknown as CloudflareClient;
    const { ctx } = makeContext({ deps: { cloudflare: cf }, outputs: { builds: { previewTrigger: "tr-2" } } });
    await expect(startBuildStep.run(ctx)).rejects.toThrow('finished with "fail"');
    expect(getBuildLog).not.toHaveBeenCalled();
  });

  it("gives up after 30 minutes", async () => {
    let t = 0;
    const { ctx } = withBuilds([], () => (t += 11 * 60_000));
    await expect(startBuildStep.run(ctx)).rejects.toThrow("still running after 30 minutes");
  });
});

describe("STEPS", () => {
  it("lists every step in pipeline order", () => {
    expect(STEPS.map((s) => s.id)).toEqual([...STEP_IDS]);
  });
});
