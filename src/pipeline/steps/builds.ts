import type { BuildTrigger, TriggerInput } from "../../clients/cloudflare.ts";
import { MIGRATION_BRANCH, PREVIEW_TRIGGER, PRODUCTION_TRIGGER } from "../../config.ts";
import { ApiError } from "../../http.ts";
import { triggerVariables } from "../../translate/env-plan.ts";
import { execString, runScriptCommand } from "../../translate/package-manager.ts";
import { BuildFailedError, buildDashboardUrl, interpretBuild } from "../build-status.ts";
import { PauseError, type Step } from "../types.ts";
import { requireOutput, requireRepo } from "./shared.ts";

// Preview branches are built to prove they compile, but never deployed, so they
// can't replace production. Spike 2 records whether cf can upload previews.
export const PREVIEW_DEPLOY_COMMAND = 'echo "Switchyard: preview branches are built but not deployed"';

// What the API token behind a build token needs: what the dashboard gives the tokens it creates
// for Builds, plus Workers CI so Switchyard can register it. Builds only accepts user tokens, so
// the user creates it on their profile page; these keys fill in that form.
const BUILD_TOKEN_PERMISSIONS = [
  { key: "account_settings", type: "read" },
  { key: "workers_scripts", type: "edit" },
  { key: "workers_ci", type: "edit" },
  { key: "workers_kv_storage", type: "edit" },
  { key: "workers_r2", type: "edit" },
  { key: "workers_routes", type: "edit" },
  { key: "user_details", type: "read" },
  { key: "memberships", type: "read" },
];

// Cloudflare's API token form with the permissions filled in, limited to one account.
export function buildTokenFormUrl(accountId: string): string {
  const url = new URL("https://dash.cloudflare.com/profile/api-tokens");
  url.searchParams.set("permissionGroupKeys", JSON.stringify(BUILD_TOKEN_PERMISSIONS));
  url.searchParams.set("accountId", accountId);
  url.searchParams.set("zoneId", "all");
  url.searchParams.set("name", "Switchyard");
  return url.toString();
}

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
          // Installing the GitHub App from GitHub alone doesn't link it to the Cloudflare
          // account (error 8000008); the dashboard's Add account flow does.
          reason: `Cloudflare couldn't connect to ${repo.owner}/${repo.name}. In Workers & Pages, select Create application, then Connect to Git, choose + Add account and Install & Authorize for ${repo.owner} with access to this repository. Once ${repo.owner} is listed you can leave that page, then select Check again. (${e.message})`,
          actionLabel: "Open Workers & Pages",
          actionUrl: `https://dash.cloudflare.com/${accountId}/workers-and-pages`,
        });
      }
      throw e;
    }

    const [token] = await cf.listBuildTokens(accountId);
    if (!token) {
      // Build tokens belong to the user who made them, and the API lists only the caller's own,
      // so a token another member of the account made doesn't count.
      const email = await cf
        .getUser()
        .then((u) => u.email)
        .catch(() => null);
      const who = email ? `signed in as ${email}` : "signed in as the Cloudflare user you connected Switchyard with";
      throw new PauseError({
        reason: `Workers Builds needs an API token of your own to build and deploy on each push. Create one with the button below, ${who} (the permissions are filled in), then paste it here. Cloudflare keeps the token; Switchyard doesn't store it, and later migrations reuse it.`,
        actionLabel: "Create the token",
        actionUrl: buildTokenFormUrl(accountId),
        input: "cloudflare-build-token",
      });
    }

    const existing = await cf.listTriggers(accountId, workerTag);
    // A trigger keeps its build token, even one since deleted, so point old triggers at this one.
    for (const t of existing) {
      if (t.build_token_uuid && t.build_token_uuid !== token.build_token_uuid) {
        await cf.setTriggerBuildToken(accountId, t.trigger_uuid, token.build_token_uuid);
      }
    }
    const exec = (line: string) => execString(plan.packageManager, line);
    const script = ctx.output("convert").buildScript;
    const run = script ? runScriptCommand(plan.packageManager, script) : null;
    const buildCommand = run ? [run.cmd, ...run.args].join(" ") : exec("cf build");
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
      build_command: buildCommand,
      deploy_command: exec("cf deploy --prebuilt"),
      branch_includes: [repo.productionBranch],
      branch_excludes: [],
    });
    const preview = await ensure({
      ...base,
      trigger_name: PREVIEW_TRIGGER,
      build_command: buildCommand,
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
        // The log is only extra detail for an agent; failing to read it mustn't hide the failure.
        const log = await cf.getBuildLogs(accountId, buildUuid).catch(() => "");
        throw new BuildFailedError(`The Cloudflare build finished with "${build.build_outcome ?? build.status}". Open the build log: ${url}`, log);
      }
      if (ctx.deps.now() > deadline) {
        throw new Error(`The Cloudflare build is still running after 30 minutes. Check it in the dashboard: ${url}`);
      }
      await ctx.deps.sleep(POLL_MS);
    }
  },
};
