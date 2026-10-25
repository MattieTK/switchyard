import type { BuildToken, BuildTrigger, TriggerInput } from "../../clients/cloudflare.ts";
import { MIGRATION_BRANCH, PREVIEW_TRIGGER, PRODUCTION_TRIGGER } from "../../config.ts";
import { ApiError } from "../../http.ts";
import { triggerVariables } from "../../translate/env-plan.ts";
import { execString, runScriptCommand } from "../../translate/package-manager.ts";
import { buildDashboardUrl, interpretBuild } from "../build-status.ts";
import { PauseError, type Step, type StepContext } from "../types.ts";
import { requireOutput, requireRepo } from "./shared.ts";

// Preview branches are built to prove they compile, but never deployed, so they
// can't replace production. Spike 2 records whether cf can upload previews.
export const PREVIEW_DEPLOY_COMMAND = 'echo "Switchyard: preview branches are built but not deployed"';

const BUILD_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 10_000;

const BUILD_TOKEN_NAME = "Switchyard Workers Builds";

// The permissions the dashboard gives the API token behind a build token it creates, less
// User Details Read and Memberships Read, which an account API token can't hold.
const BUILD_TOKEN_PERMISSIONS = [
  "Account Settings Read",
  "Workers Scripts Write",
  "Workers KV Storage Write",
  "Workers R2 Storage Write",
  "Workers Routes Write",
];
const ZONE_SCOPE = "com.cloudflare.api.account.zone";

// Creates an account API token with the build permissions and registers it as a build token,
// for a user who has none. Needs the account-api-tokens.write scope, which sessions from
// before Switchyard asked for it don't have. Pauses with what to do when it can't.
async function provisionBuildToken(ctx: StepContext): Promise<BuildToken> {
  const { plan, accountId } = ctx.job;
  const cf = ctx.deps.cloudflare;
  let apiToken: { id: string; value: string } | null = null;
  try {
    const groups = await cf.listTokenPermissionGroups(accountId);
    const chosen = BUILD_TOKEN_PERMISSIONS.map((name) => groups.find((g) => g.name === name));
    const missing = BUILD_TOKEN_PERMISSIONS.filter((_, i) => !chosen[i]);
    if (missing.length) throw new Error(`Cloudflare doesn't offer the permissions ${missing.join(", ")}`);
    const found = chosen.filter((g) => g !== undefined);
    const ids = (zone: boolean) => found.filter((g) => g.scopes.includes(ZONE_SCOPE) === zone).map((g) => ({ id: g.id }));
    const account = `com.cloudflare.api.account.${accountId}`;
    apiToken = await cf.createAccountToken(accountId, {
      name: BUILD_TOKEN_NAME,
      policies: [
        { effect: "allow", permission_groups: ids(false), resources: { [account]: "*" } },
        { effect: "allow", permission_groups: ids(true), resources: { [account]: { [`${ZONE_SCOPE}.*`]: "*" } } },
      ],
    });
    ctx.addSecret(apiToken.value);
    const token = await cf.createBuildToken(accountId, {
      build_token_name: BUILD_TOKEN_NAME,
      build_token_secret: apiToken.value,
      cloudflare_token_id: apiToken.id,
    });
    ctx.log(`Created the Workers Builds token "${BUILD_TOKEN_NAME}"`);
    return token;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (apiToken) {
      await cf.deleteAccountToken(accountId, apiToken.id).catch(() => {
        ctx.log(`Warning: Couldn't delete the unused API token "${BUILD_TOKEN_NAME}". Delete it under Manage account → Account API tokens.`);
      });
    }
    // Build tokens belong to the user who made them, and the API lists only the caller's own,
    // so a token another member of the account made in the dashboard doesn't count.
    const email = await cf
      .getUser()
      .then((u) => u.email)
      .catch(() => null);
    const who = email ? `signed in to the dashboard as ${email}` : "signed in to the dashboard as the Cloudflare user you connected Switchyard with";
    const dashboard = `${who}, open any Worker other than ${plan.workerName}, go to Settings → Builds and connect a repository once – Cloudflare creates a Workers Builds token then.`;
    throw new PauseError({
      reason: apiToken
        ? `Workers Builds didn't accept the API token Switchyard created (${message}), so Switchyard deleted it. Instead, ${dashboard} Then select Check again.`
        : `You have no Workers Builds token on this account, and Switchyard couldn't create one (${message}). If you connected Cloudflare before Switchyard asked for permission to create API tokens, reconnect Cloudflare, then select Check again. Or, ${dashboard}`,
      actionLabel: "Open Workers & Pages",
      actionUrl: `https://dash.cloudflare.com/${accountId}/workers-and-pages`,
      ...(apiToken ? {} : { reconnect: "cloudflare" as const }),
    });
  }
}

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

    const token = (await cf.listBuildTokens(accountId))[0] ?? (await provisionBuildToken(ctx));

    const existing = await cf.listTriggers(accountId, workerTag);
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
        throw new Error(`The Cloudflare build finished with "${build.build_outcome ?? build.status}". Open the build log: ${url}`);
      }
      if (ctx.deps.now() > deadline) {
        throw new Error(`The Cloudflare build is still running after 30 minutes. Check it in the dashboard: ${url}`);
      }
      await ctx.deps.sleep(POLL_MS);
    }
  },
};
