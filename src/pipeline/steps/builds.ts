import type { BuildTrigger, TriggerInput } from "../../clients/cloudflare.ts";
import { MIGRATION_BRANCH, PREVIEW_TRIGGER, PRODUCTION_TRIGGER } from "../../config.ts";
import { ApiError } from "../../http.ts";
import { triggerVariables } from "../../translate/env-plan.ts";
import { execCommand, execString, installEnv, runScriptCommand } from "../../translate/package-manager.ts";
import { logFixWithAIHint, repairWarning, repairWithAI } from "../ai-repair.ts";
import { buildDashboardUrl, interpretBuild } from "../build-status.ts";
import { PauseError, type Step, type StepContext } from "../types.ts";
import { commitAndPush } from "./release.ts";
import { buildEnv, requireOutput, requireRepo } from "./shared.ts";

// Preview branches are built to prove they compile, but never deployed, so they
// can't replace production. cf has no command that builds and uploads a preview version yet.
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

// How many times OpenAI can fix a failed Workers Builds build, each followed by a new build.
const MAX_CLOUD_REPAIRS = 2;

export const startBuildStep: Step = {
  id: "start-build",
  title: "Run the first Cloudflare build",
  async run(ctx) {
    const { plan, accountId } = ctx.job;
    const cf = ctx.deps.cloudflare;
    const trigger = requireOutput(ctx, "builds", "previewTrigger");
    let repairs = 0;
    // Fix with AI after a failed build: OpenAI starts from that build's log, rather than from
    // another build that would fail the same way.
    const failed = ctx.outputs.failedBuild;
    if (failed) {
      delete ctx.outputs.failedBuild;
      const url = buildDashboardUrl(accountId, plan.workerName, failed);
      if (!(await repairCloudBuild(ctx, failed))) throw new Error(`OpenAI didn't fix the Cloudflare build. Open the build log: ${url}`);
      repairs++;
    }
    for (; ; repairs++) {
      const buildUuid = await cf.startBuild(accountId, trigger, MIGRATION_BRANCH);
      const url = buildDashboardUrl(accountId, plan.workerName, buildUuid);
      ctx.outputs.buildUuid = buildUuid;
      ctx.outputs.buildUrl = url;
      ctx.log(`Started build ${buildUuid}: ${url}`);

      const outcome = await waitForBuild(ctx, buildUuid, url);
      if (outcome === null) return;
      if (repairs < MAX_CLOUD_REPAIRS && (await repairCloudBuild(ctx, buildUuid))) continue;
      throw new Error(`The Cloudflare build finished with "${outcome}". Open the build log: ${url}`);
    }
  },
};

// Polls a build until it ends. Returns null when it succeeded, or its outcome when it failed.
async function waitForBuild(ctx: StepContext, buildUuid: string, url: string): Promise<string | null> {
  const cf = ctx.deps.cloudflare;
  const deadline = ctx.deps.now() + BUILD_TIMEOUT_MS;
  let last = "";
  for (;;) {
    const build = await cf.getBuild(ctx.job.accountId, buildUuid);
    const label = build.build_outcome ? `${build.status} (${build.build_outcome})` : build.status;
    if (label !== last) {
      ctx.log(`Build status: ${label}`);
      last = label;
    }
    const state = interpretBuild(build);
    if (state === "success") return null;
    if (state === "failure") return build.build_outcome ?? build.status;
    if (ctx.deps.now() > deadline) {
      throw new Error(`The Cloudflare build is still running after 30 minutes. Check it in the dashboard: ${url}`);
    }
    await ctx.deps.sleep(POLL_MS);
  }
}

// Asks OpenAI to fix a failed Workers Builds build from its log. The fix is checked with a local
// install and build, as Workers Builds runs them, then pushed to the migration branch and noted on
// the pull request. Returns whether there's a fix to build again.
async function repairCloudBuild(ctx: StepContext, buildUuid: string): Promise<boolean> {
  if (!ctx.job.plan.options?.aiRepair) {
    await logFixWithAIHint(ctx);
    return false;
  }
  const { plan } = ctx.job;
  const repo = requireRepo(plan);
  const dir = requireOutput(ctx, "convert", "projectDir");
  const log = await ctx.deps.cloudflare.getBuildLog(ctx.job.accountId, buildUuid).catch((e: unknown) => {
    ctx.log(`Couldn't read the build log: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (!log?.length) return false;

  const pm = plan.packageManager;
  const env = { ...buildEnv(ctx, "preview"), CI: "1" };
  const script = ctx.output("convert").buildScript;
  const build = script ? runScriptCommand(pm, script) : execCommand(pm, "cf", ["build"]);
  const what = "the Workers Builds build";
  const repair = await repairWithAI(ctx, {
    what,
    output: log.join("\n"),
    projectDir: dir,
    // A clean install, as on Workers Builds, then the trigger's build command.
    async verify() {
      const install = await ctx.deps.run(pm, pm === "npm" ? ["ci"] : ["install"], { cwd: dir, onLine: ctx.log, env: { ...installEnv(pm), ...env } });
      if (install.code !== 0) return install;
      const built = await ctx.deps.run(build.cmd, build.args, { cwd: dir, onLine: ctx.log, env });
      return { ...built, output: `${install.output}\n${built.output}` };
    },
    notes: [
      `This failed on Workers Builds, Cloudflare's CI. It cloned the migration branch, installed dependencies with CI set (so lockfiles must match package.json), then ran ${[build.cmd, ...build.args].join(" ")}. The same build passed on this machine, so look for what differs there: the Node.js version in .nvmrc or .node-version, the package manager's version in package.json's packageManager field, a lockfile out of date, files that are ignored or not committed, or letter case in import paths.`,
      "run_check installs the dependencies and builds on this machine, as Workers Builds does. Your changes are pushed to the migration branch and built on Workers Builds again afterwards.",
    ],
  });
  if (!repair?.fixed) return false;
  if (!repair.changed.length) {
    ctx.log("OpenAI changed nothing, so building again would fail the same way.");
    return false;
  }
  await commitAndPush(ctx, [`fix: ${what} on Cloudflare`, `OpenAI (${repair.model}): ${repair.summary}`]);
  const gh = await ctx.deps.github();
  const pr = await gh.findOpenPr(repo.owner, repo.name, MIGRATION_BRANCH);
  if (pr) {
    await gh
      .commentOnPr(repo.owner, repo.name, pr.number, `Switchyard: ${repairWarning(repair, what)}`)
      .catch((e: unknown) => ctx.log(`Couldn't comment on the pull request: ${e instanceof Error ? e.message : String(e)}`));
  }
  return true;
}
