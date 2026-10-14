import { rm } from "node:fs/promises";
import { join } from "node:path";
import { gitAuthEnv } from "../../auth/github.ts";
import { prBody } from "../../codegen/pr-body.ts";
import { MIGRATION_BRANCH } from "../../config.ts";
import { runOrThrow } from "../../exec.ts";
import { writeFileSecure } from "../../fs-secure.ts";
import { runtimeSecrets } from "../../translate/env-plan.ts";
import { execCommand } from "../../translate/package-manager.ts";
import type { Step } from "../types.ts";
import { git, productionBuildEnv, requireOutput, requireRepo } from "./shared.ts";

const WORKERS_DEV = /https:\/\/[a-z0-9.-]+\.workers\.dev/i;

export const deployStep: Step = {
  id: "deploy",
  title: "Create the Worker with a first deploy",
  async run(ctx) {
    const { plan, accountId } = ctx.job;
    const dir = requireOutput(ctx, "convert", "projectDir");
    const token = await ctx.deps.cloudflareToken();
    ctx.addSecret(token);

    const secrets = runtimeSecrets(plan.env, ctx.values);
    const hasSecrets = Object.keys(secrets).length > 0;
    // Outside the repository, so it can never be committed.
    const secretsFile = join(ctx.deps.workDir, `${ctx.job.id}.secrets.json`);
    const args = ["deploy", "--message", "First deploy by Switchyard"];
    if (hasSecrets) {
      await writeFileSecure(secretsFile, JSON.stringify(secrets));
      args.push("--secrets-file", secretsFile);
    }

    try {
      const { cmd, args: full } = execCommand(plan.packageManager, "cf", args);
      const result = await runOrThrow(ctx.deps.run, cmd, full, {
        cwd: dir,
        onLine: ctx.log,
        env: { ...productionBuildEnv(ctx), CI: "1", CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
      });
      const url = result.output.match(WORKERS_DEV)?.[0];
      if (url) ctx.outputs.workersDevUrl = url;
    } finally {
      if (hasSecrets) await rm(secretsFile, { force: true });
    }

    const tag = await ctx.deps.cloudflare.getWorkerTag(accountId, plan.workerName);
    if (!tag) throw new Error(`The Worker ${plan.workerName} wasn't found on the account after deploying.`);
    ctx.outputs.workerTag = tag;
  },
};

export const pushStep: Step = {
  id: "push",
  title: "Push the migration branch",
  async run(ctx) {
    const repoDir = requireOutput(ctx, "clone", "dir");
    const token = await ctx.deps.githubToken();
    ctx.addSecret(token);
    const local = git(ctx, repoDir);

    await local(["add", "-A"]);
    const status = await runOrThrow(ctx.deps.run, "git", ["status", "--porcelain"], { cwd: repoDir });
    if (status.output.trim()) {
      // The repository's own hooks aren't Switchyard's to run, and a fresh clone may have no git identity.
      const identity = await ctx.deps.run("git", ["config", "user.email"], { cwd: repoDir });
      const asSwitchyard =
        identity.code === 0 && identity.stdout.trim() ? [] : ["-c", "user.name=Switchyard", "-c", "user.email=switchyard@localhost"];
      await local([
        ...asSwitchyard,
        "commit",
        "--no-verify",
        "-m",
        "chore: move hosting from Vercel to Cloudflare Workers",
        "-m",
        "Converted by Switchyard. The pull request lists the remaining steps.",
      ]);
    }
    // The refspec is fixed: this is the only branch Switchyard ever pushes to.
    await git(ctx, repoDir, gitAuthEnv(token))(["push", "--force", "origin", `HEAD:refs/heads/${MIGRATION_BRANCH}`]);
    ctx.outputs.branch = MIGRATION_BRANCH;
  },
};

export const prStep: Step = {
  id: "pr",
  title: "Open the pull request",
  async run(ctx) {
    const { plan } = ctx.job;
    const repo = requireRepo(plan);
    const gh = await ctx.deps.github();
    const existing = await gh.findOpenPr(repo.owner, repo.name, MIGRATION_BRANCH);
    const warnings = (["convert", "build"] as const).flatMap(
      (step) => JSON.parse(ctx.output(step).warnings ?? "[]") as string[],
    );
    const pr =
      existing ??
      (await gh.createPr(repo.owner, repo.name, {
        title: `Move ${plan.projectName} from Vercel to Cloudflare Workers`,
        head: MIGRATION_BRANCH,
        base: repo.productionBranch,
        body: prBody({
          projectName: plan.projectName,
          productionBranch: repo.productionBranch,
          workersDevUrl: ctx.output("deploy").workersDevUrl,
          hasCrons: plan.vercelJson.crons.length > 0,
          skippedEnv: plan.env.entries.flatMap((e) => (e.skipReason ? [{ key: e.key, reason: e.skipReason }] : [])),
          manual: plan.vercelJson.manual,
          features: plan.features,
          storage: plan.storage,
          warnings,
        }),
      }));
    ctx.outputs.prUrl = pr.url;
    ctx.log(existing ? `Using the open pull request ${pr.url}` : `Opened ${pr.url}`);
  },
};
