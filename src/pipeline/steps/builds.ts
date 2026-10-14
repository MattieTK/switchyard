import type { BuildTrigger, TriggerInput } from "../../clients/cloudflare.ts";
import { GITHUB_APP_INSTALL_URL, MIGRATION_BRANCH, PREVIEW_TRIGGER, PRODUCTION_TRIGGER } from "../../config.ts";
import { ApiError } from "../../http.ts";
import { triggerVariables } from "../../translate/env-plan.ts";
import { execString } from "../../translate/package-manager.ts";
import { buildDashboardUrl, interpretBuild } from "../build-status.ts";
import { PauseError, type Step } from "../types.ts";
import { requireOutput, requireRepo } from "./shared.ts";

// Preview branches are built to prove they compile, but never deployed, so they
// can't replace production. Spike 2 records whether cf can upload previews.
export const PREVIEW_DEPLOY_COMMAND = 'echo "Switchyard: preview branches are built but not deployed"';

const BUILD_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 10_000;

export const buildsStep: Step = {
  id: "builds",
  title: "Connect Workers Builds",
  async run(ctx) {
    const { plan, accountId } = ctx.job;
    const repo = requireRepo(plan);
    const workerTag = requireOutput(ctx, "deploy", "workerTag");
    const cf = ctx.deps.cloudflare;
    const info = await (await ctx.deps.github()).getRepo(repo.owner, repo.name);

    let connection: string;
    try {
      connection = await cf.putRepoConnection(accountId, {
        provider_type: "github",
        provider_account_id: String(info.ownerId),
        provider_account_name: info.ownerLogin,
        repo_id: String(info.id),
        repo_name: info.name,
      });
    } catch (e) {
      if (e instanceof ApiError && !e.auth && e.status >= 400 && e.status < 500) {
        throw new PauseError({
          reason: `Cloudflare couldn't connect to ${repo.owner}/${repo.name}. Install the Cloudflare Workers and Pages GitHub App on ${repo.owner} with access to this repository, then select Check again. (${e.message})`,
          actionLabel: "Install the GitHub App",
          actionUrl: GITHUB_APP_INSTALL_URL,
        });
      }
      throw e;
    }

    const [token] = await cf.listBuildTokens(accountId);
    if (!token) {
      throw new PauseError({
        reason:
          "Your Cloudflare account has no Workers Builds token yet. In the dashboard, open any Worker, go to Settings → Builds and connect a repository once – Cloudflare creates the token then. Then select Check again.",
        actionLabel: "Open Workers & Pages",
        actionUrl: `https://dash.cloudflare.com/${accountId}/workers-and-pages`,
      });
    }

    const existing = await cf.listTriggers(accountId, workerTag);
    const exec = (line: string) => execString(plan.packageManager, line);
    const base = {
      external_script_id: workerTag,
      repo_connection_uuid: connection,
      build_token_uuid: token.build_token_uuid,
      root_directory: repo.rootDirectory ? `/${repo.rootDirectory}` : "/",
      path_includes: ["*"],
      path_excludes: [],
      build_caching_enabled: true,
    };
    const ensure = async (input: TriggerInput): Promise<BuildTrigger> =>
      existing.find((t) => t.trigger_name === input.trigger_name) ?? cf.createTrigger(accountId, input);

    const production = await ensure({
      ...base,
      trigger_name: PRODUCTION_TRIGGER,
      build_command: exec("cf build"),
      deploy_command: exec("cf deploy --prebuilt"),
      branch_includes: [repo.productionBranch],
      branch_excludes: [],
    });
    const preview = await ensure({
      ...base,
      trigger_name: PREVIEW_TRIGGER,
      build_command: exec("cf build"),
      deploy_command: PREVIEW_DEPLOY_COMMAND,
      branch_includes: ["*"],
      branch_excludes: [repo.productionBranch],
    });

    for (const [trigger, which] of [
      [production, "production"],
      [preview, "preview"],
    ] as const) {
      const vars = triggerVariables(plan.env, ctx.values, which);
      if (Object.keys(vars).length) await cf.setTriggerEnv(accountId, trigger.trigger_uuid, vars);
      ctx.log(`${trigger.trigger_name}: ${Object.keys(vars).length} build variables set`);
    }
    ctx.outputs.productionTrigger = production.trigger_uuid;
    ctx.outputs.previewTrigger = preview.trigger_uuid;
  },
};

export const startBuildStep: Step = {
  id: "start-build",
  title: "Run the first Cloudflare build",
  async run(ctx) {
    const { plan, accountId } = ctx.job;
    const cf = ctx.deps.cloudflare;
    const trigger = requireOutput(ctx, "builds", "previewTrigger");
    const buildUuid = await cf.startBuild(accountId, trigger, MIGRATION_BRANCH);
    const url = buildDashboardUrl(accountId, plan.workerName, buildUuid);
    ctx.outputs.buildUuid = buildUuid;
    ctx.outputs.buildUrl = url;
    ctx.log(`Started build ${buildUuid}: ${url}`);

    const deadline = ctx.deps.now() + BUILD_TIMEOUT_MS;
    let last = "";
    for (;;) {
      const build = await cf.getBuild(accountId, buildUuid);
      const label = build.build_outcome ? `${build.status} (${build.build_outcome})` : build.status;
      if (label !== last) {
        ctx.log(`Build status: ${label}`);
        last = label;
      }
      const state = interpretBuild(build);
      if (state === "success") return;
      if (state === "failure") {
        throw new Error(`The Cloudflare build finished with "${build.build_outcome ?? build.status}". Open the build log: ${url}`);
      }
      if (ctx.deps.now() > deadline) {
        throw new Error(`The Cloudflare build is still running after 30 minutes. Check it in the dashboard: ${url}`);
      }
      await ctx.deps.sleep(POLL_MS);
    }
  },
};
