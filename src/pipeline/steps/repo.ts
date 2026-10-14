import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitAuthEnv } from "../../auth/github.ts";
import { editCloudflareConfig } from "../../codegen/config-edit.ts";
import { CRON_ENTRY_FILE, cronEntrySource } from "../../codegen/cron-entry.ts";
import { addGitignoreEntries } from "../../codegen/gitignore.ts";
import { MIGRATION_BRANCH } from "../../config.ts";
import { runOrThrow } from "../../exec.ts";
import { devVarsFile, secretKeys } from "../../translate/env-plan.ts";
import { execCommand } from "../../translate/package-manager.ts";
import type { Step } from "../types.ts";
import { git, projectDirFor, requireOutput, requireRepo } from "./shared.ts";

export const cloneStep: Step = {
  id: "clone",
  title: "Clone the repository",
  async run(ctx) {
    const repo = requireRepo(ctx.job.plan);
    const dir = join(ctx.deps.workDir, ctx.job.id);
    const token = await ctx.deps.githubToken();
    ctx.addSecret(token);
    const authed = git(ctx, dir, gitAuthEnv(token));

    if (existsSync(join(dir, ".git"))) {
      await authed(["fetch", "--depth", "1", "origin", repo.productionBranch]);
    } else {
      await rm(dir, { recursive: true, force: true });
      await mkdir(ctx.deps.workDir, { recursive: true });
      await runOrThrow(
        ctx.deps.run,
        "git",
        [
          "clone",
          "--depth",
          "1",
          "--branch",
          repo.productionBranch,
          `https://github.com/${repo.owner}/${repo.name}.git`,
          dir,
        ],
        { env: gitAuthEnv(token), onLine: ctx.log },
      );
    }
    await git(ctx, dir)(["checkout", "-B", MIGRATION_BRANCH, `origin/${repo.productionBranch}`]);
    ctx.outputs.dir = dir;
  },
};

export const convertStep: Step = {
  id: "convert",
  title: "Convert the project",
  async run(ctx) {
    const { plan } = ctx.job;
    const repo = requireRepo(plan);
    const repoDir = requireOutput(ctx, "clone", "dir");
    const local = git(ctx, repoDir);
    // Start from a clean checkout every time, so a retry never edits twice.
    await local(["reset", "--hard", `origin/${repo.productionBranch}`]);
    await local(["clean", "-fdx", "-e", "node_modules"]);

    const adapter = ctx.deps.adapter(plan.adapterId ?? "");
    if (!adapter) throw new Error(`There is no converter for ${plan.adapterId ?? "this framework"}.`);
    const dir = projectDirFor(repoDir, repo.rootDirectory);
    const result = await adapter.convert({
      dir,
      pm: plan.packageManager,
      run: ctx.deps.run,
      log: ctx.log,
      options: { nextCache: plan.nextCache },
    });
    for (const w of result.warnings) ctx.log(`Warning: ${w}`);

    const configPath = join(dir, "cloudflare.config.ts");
    const source = await readFile(configPath, "utf8").catch(() => {
      throw new Error("The converter didn't create cloudflare.config.ts.");
    });
    const crons = plan.vercelJson.crons;
    if (crons.length) await writeFile(join(dir, CRON_ENTRY_FILE), cronEntrySource(result.baseEntrypoint, crons));
    await writeFile(
      configPath,
      editCloudflareConfig(source, {
        workerName: plan.workerName,
        secretKeys: secretKeys(plan.env),
        crons,
        entrypoint: crons.length ? `./${CRON_ENTRY_FILE}` : undefined,
      }),
    );

    const gitignorePath = join(dir, ".gitignore");
    const gitignore = await readFile(gitignorePath, "utf8").catch(() => "");
    await writeFile(gitignorePath, addGitignoreEntries(gitignore, ["node_modules/", ".dev.vars", ".cloudflare/"]));

    // Not writeFileSecure: that chmods the parent folder, which is the user's project directory.
    // The explicit chmod also tightens a .dev.vars that already existed with looser permissions.
    const devVars = devVarsFile(plan.env, ctx.values);
    if (devVars) {
      const devVarsPath = join(dir, ".dev.vars");
      await writeFile(devVarsPath, devVars, { mode: 0o600 });
      await chmod(devVarsPath, 0o600);
    }

    ctx.outputs.projectDir = dir;
    ctx.outputs.warnings = JSON.stringify(result.warnings);
  },
};

export const buildStep: Step = {
  id: "build",
  title: "Build locally with cf",
  async run(ctx) {
    const dir = requireOutput(ctx, "convert", "projectDir");
    const { cmd, args } = execCommand(ctx.job.plan.packageManager, "cf", ["build"]);
    await runOrThrow(ctx.deps.run, cmd, args, { cwd: dir, onLine: ctx.log, env: { CI: "1" } });
  },
};
