import { describe, expect, it, vi } from "vitest";
import type { BuildInfo, CloudflareClient, TriggerInput } from "../../../src/clients/cloudflare.ts";
import type { GitHubClient } from "../../../src/clients/github.ts";
import { ApiError } from "../../../src/http.ts";
import { buildsStep, PREVIEW_DEPLOY_COMMAND, startBuildStep } from "../../../src/pipeline/steps/builds.ts";
import { STEPS } from "../../../src/pipeline/steps/index.ts";
import { PauseError, STEP_IDS } from "../../../src/pipeline/types.ts";
import { buildEnvPlan } from "../../../src/translate/env-plan.ts";
import { makeContext } from "../../helpers/step-context.ts";

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

  const GROUPS = [
    { id: "g-settings", name: "Account Settings Read", scopes: ["com.cloudflare.api.account"] },
    { id: "g-scripts", name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] },
    { id: "g-kv", name: "Workers KV Storage Write", scopes: ["com.cloudflare.api.account"] },
    { id: "g-r2", name: "Workers R2 Storage Write", scopes: ["com.cloudflare.api.account"] },
    { id: "g-routes", name: "Workers Routes Write", scopes: ["com.cloudflare.api.account.zone"] },
    { id: "g-other", name: "DNS Write", scopes: ["com.cloudflare.api.account.zone"] },
  ];

  it("creates a build token from a new account API token when the user has none", async () => {
    const createAccountToken = vi.fn(async () => ({ id: "tok-1", value: "token-secret" }));
    const createBuildToken = vi.fn(async () => ({ build_token_uuid: "bt-new", build_token_name: "Switchyard Workers Builds" }));
    const { cf, created } = cloudflare({
      listBuildTokens: async () => [],
      listTokenPermissionGroups: async () => GROUPS,
      createAccountToken,
      createBuildToken,
    });
    const { ctx, secrets } = makeContext({ deps: { cloudflare: cf, github: async () => github }, outputs: { deploy: { workerTag: "t" } } });
    await buildsStep.run(ctx);

    // The permissions the dashboard gives the build token it creates, minus the user-level ones,
    // which an account token can't hold.
    expect(createAccountToken).toHaveBeenCalledWith("acc", {
      name: "Switchyard Workers Builds",
      policies: [
        {
          effect: "allow",
          permission_groups: [{ id: "g-settings" }, { id: "g-scripts" }, { id: "g-kv" }, { id: "g-r2" }],
          resources: { "com.cloudflare.api.account.acc": "*" },
        },
        {
          effect: "allow",
          permission_groups: [{ id: "g-routes" }],
          resources: { "com.cloudflare.api.account.acc": { "com.cloudflare.api.account.zone.*": "*" } },
        },
      ],
    });
    expect(secrets).toContain("token-secret");
    expect(createBuildToken).toHaveBeenCalledWith("acc", {
      build_token_name: "Switchyard Workers Builds",
      build_token_secret: "token-secret",
      cloudflare_token_id: "tok-1",
    });
    expect(created.map((t) => t.build_token_uuid)).toEqual(["bt-new", "bt-new"]);
  });

  it("deletes the API token when Workers Builds won't take it, and pauses with the dashboard steps", async () => {
    const deleteAccountToken = vi.fn(async () => {});
    const { cf } = cloudflare({
      listBuildTokens: async () => [],
      getUser: async () => ({ id: "u", email: "me@example.com" }),
      listTokenPermissionGroups: async () => GROUPS,
      createAccountToken: async () => ({ id: "tok-1", value: "token-secret" }),
      createBuildToken: async () => {
        throw new ApiError("cloudflare", 400, "Invalid token");
      },
      deleteAccountToken,
    });
    const { ctx } = makeContext({ deps: { cloudflare: cf, github: async () => github }, outputs: { deploy: { workerTag: "t" } } });
    const err = await buildsStep.run(ctx).catch((e: unknown) => e);
    expect(deleteAccountToken).toHaveBeenCalledWith("acc", "tok-1");
    expect(err).toBeInstanceOf(PauseError);
    expect((err as PauseError).pause.reason).toContain("Invalid token");
    expect((err as PauseError).pause.reason).toContain("signed in to the dashboard as me@example.com");
  });

  it("pauses asking to reconnect Cloudflare when Switchyard can't create API tokens", async () => {
    const { cf } = cloudflare({
      listBuildTokens: async () => [],
      getUser: async () => ({ id: "u", email: "me@example.com" }),
      listTokenPermissionGroups: async () => {
        throw new ApiError("cloudflare", 403, "Authentication error (10000)");
      },
    });
    const { ctx } = makeContext({ deps: { cloudflare: cf, github: async () => github }, outputs: { deploy: { workerTag: "t" } } });
    const err = (await buildsStep.run(ctx).catch((e: unknown) => e)) as PauseError;
    expect(err.pause.reconnect).toBe("cloudflare");
    expect(err.pause.reason).toContain("Authentication error");
    expect(err.pause.reason).toContain("reconnect Cloudflare");
  });

  it("pauses when the connected user has no build token, naming that user", async () => {
    // Build tokens belong to a user, so one made by another member of the account isn't listed.
    const { cf } = cloudflare({
      listBuildTokens: async () => [],
      getUser: async () => ({ id: "u", email: "me@example.com" }),
      listTokenPermissionGroups: async () => GROUPS.filter((g) => g.name !== "Workers Routes Write"),
    });
    const { ctx } = makeContext({ deps: { cloudflare: cf, github: async () => github }, outputs: { deploy: { workerTag: "t" } } });
    const err = await buildsStep.run(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PauseError);
    expect((err as PauseError).pause.reason).toContain("Builds token");
    expect((err as PauseError).pause.reason).toContain("signed in to the dashboard as me@example.com");

    // Without the user's details the message still explains what to do.
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
