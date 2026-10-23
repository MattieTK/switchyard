import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { gitAuthEnv } from "../../auth/github.ts";
import { editCloudflareConfig } from "../../codegen/config-edit.ts";
import { CRON_ENTRY_FILE, cronEntrySource } from "../../codegen/cron-entry.ts";
import { addGitignoreEntries } from "../../codegen/gitignore.ts";
import {
  approveBuilds,
  MIN_NODE_MAJOR,
  NODE_VERSION_FILES,
  raiseNodeVersion,
  undecidedBuilds,
} from "../../codegen/toolchain-files.ts";
import { MIGRATION_BRANCH } from "../../config.ts";
import { CommandError, runOrThrow } from "../../exec.ts";
import { devVarsFile, secretKeys } from "../../translate/env-plan.ts";
import {
  addCommand,
  execCommand,
  installEnv,
  type PackageManager,
  runScriptCommand,
} from "../../translate/package-manager.ts";
import type { Step, StepContext } from "../types.ts";
import { findUndeclaredImports, previousVersion } from "../undeclared-deps.ts";
import { git, productionBuildEnv, projectDirFor, requireOutput, requireRepo } from "./shared.ts";

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

// Workers Builds installs and builds with the files in the repository, so a Node.js pin
// that cf can't run on, or a pnpm build decision left open, fails there too. Monorepos can
// keep these files at the repository root or in the project folder. installedBefore says
// whether the production branch's lockfile already had a package.
async function updateToolchainFiles(
  projectDir: string,
  repoDir: string,
  installedBefore: (name: string) => Promise<boolean>,
): Promise<string[]> {
  const warnings: string[] = [];
  const folders = [...new Set([projectDir, repoDir])];
  const read = (path: string) => readFile(path, "utf8").catch(() => null);
  for (const folder of folders) {
    for (const name of NODE_VERSION_FILES) {
      const path = join(folder, name);
      const text = await read(path);
      const raised = text === null ? null : raiseNodeVersion(text);
      if (!raised) continue;
      await writeFile(path, raised.text);
      warnings.push(
        `Switchyard changed ${relative(repoDir, path)} from ${raised.from} to ${MIN_NODE_MAJOR}, because Cloudflare's build tools need Node.js ${MIN_NODE_MAJOR} or later and Workers Builds uses the version in this file. Check the app still works on Node.js ${MIN_NODE_MAJOR}.`,
      );
    }
    const workspacePath = join(folder, "pnpm-workspace.yaml");
    const workspace = await read(workspacePath);
    if (workspace === null) continue;
    const file = relative(repoDir, workspacePath);
    // Packages the conversion added (vinext's toolchain, such as workerd, and whatever the
    // Next.js upgrade brings) are part of Switchyard's change, so their build scripts are
    // allowed. The project's own packages stay the user's decision.
    const undecided = undecidedBuilds(workspace);
    const added: string[] = [];
    const existing: string[] = [];
    for (const name of undecided) (await installedBefore(name) ? existing : added).push(name);
    if (added.length) {
      await writeFile(workspacePath, approveBuilds(workspace, added));
      warnings.push(
        `Switchyard allowed the build scripts of ${added.join(", ")} in ${file}. The conversion added these packages, and pnpm stops installing until each build script is allowed or refused. Change any to false if you'd rather not run it.`,
      );
    }
    if (existing.length) {
      warnings.push(
        `pnpm skipped the build scripts of ${existing.join(", ")} and marked them for review in ${file}. pnpm stops installing until each is set to true or false, so decide before merging.`,
      );
    }
  }
  return warnings;
}

export const convertStep: Step = {
  id: "convert",
  title: "Convert the project",
  async run(ctx) {
    const { plan } = ctx.job;
    const repo = requireRepo(plan);
    const repoDir = requireOutput(ctx, "clone", "dir");
    const local = git(ctx, repoDir);
    // Retries start from a clean checkout including dependencies, so a retry never
    // edits twice or reuses a node_modules left half-written by a failed install.
    await local(["reset", "--hard", `origin/${repo.productionBranch}`]);
    await local(["clean", "-fdx"]);

    const adapter = ctx.deps.adapter(plan.adapterId ?? "");
    if (!adapter) throw new Error(`There is no converter for ${plan.adapterId ?? "this framework"}.`);
    const dir = projectDirFor(repoDir, repo.rootDirectory);
    await ctx.deps.ensurePackageManager(plan.packageManager, dir, ctx.log);
    const result = await adapter.convert({
      dir,
      pm: plan.packageManager,
      run: ctx.deps.run,
      log: ctx.log,
      options: { nextCache: plan.nextCache },
    });
    const warnings = [
      ...result.warnings,
      ...(await updateToolchainFiles(dir, repoDir, async (name) => (await versionBeforeMigration(ctx, name)) !== null)),
    ];
    for (const w of warnings) ctx.log(`Warning: ${w}`);

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
      // A tracked .dev.vars would have the development values committed with the migration.
      const tracked = await ctx.deps.run("git", ["ls-files", "--", ".dev.vars"], { cwd: dir });
      if (tracked.stdout.trim()) {
        ctx.log("Warning: .dev.vars is tracked in git, so Switchyard didn't write development values to it.");
      } else {
        const devVarsPath = join(dir, ".dev.vars");
        await writeFile(devVarsPath, devVars, { mode: 0o600 });
        await chmod(devVarsPath, 0o600);
      }
    }

    ctx.outputs.projectDir = dir;
    if (result.buildScript) ctx.outputs.buildScript = result.buildScript;
    ctx.outputs.warnings = JSON.stringify(warnings);
  },
};

// How many times a build can be repaired by adding undeclared packages before it fails for good.
const MAX_DEPENDENCY_REPAIRS = 3;

const LOCKFILES: Record<PackageManager, readonly string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock"],
};

// The package's version in the production branch's lockfile, from before Switchyard changed anything.
async function versionBeforeMigration(ctx: StepContext, name: string): Promise<string | null> {
  const repo = requireRepo(ctx.job.plan);
  const repoDir = requireOutput(ctx, "clone", "dir");
  const folders = [...new Set([repo.rootDirectory, ""])];
  for (const folder of folders) {
    for (const file of LOCKFILES[ctx.job.plan.packageManager]) {
      const path = folder ? `${folder}/${file}` : file;
      const shown = await ctx.deps.run("git", ["show", `origin/${repo.productionBranch}:${path}`], { cwd: repoDir });
      if (shown.code === 0) return previousVersion(file, shown.stdout, name);
    }
  }
  return null;
}

// Adds packages that installed dependencies import without declaring them. Returns a
// warning for each, or nothing when the failure has another cause.
async function repairUndeclaredImports(ctx: StepContext, dir: string, output: string): Promise<string[]> {
  const missing = findUndeclaredImports(output).filter(
    // An installed package means the import failed for another reason, such as a missing export.
    (m) => !existsSync(join(dir, "node_modules", m.packageName, "package.json")),
  );
  if (!missing.length) return [];
  const additions = await Promise.all(
    missing.map(async (m) => ({ ...m, version: await versionBeforeMigration(ctx, m.packageName) })),
  );
  const pm = ctx.job.plan.packageManager;
  const add = addCommand(
    pm,
    additions.map((a) => (a.version ? `${a.packageName}@^${a.version}` : a.packageName)),
  );
  await runOrThrow(ctx.deps.run, add.cmd, add.args, { cwd: dir, onLine: ctx.log, env: installEnv(pm) });
  return additions.map(
    (a) =>
      `${a.importer} imports ${a.packageName} without listing it as a dependency, so the build couldn't find it. ` +
      (a.version
        ? `Switchyard added ${a.packageName}@^${a.version}, the version the project had installed before, to package.json.`
        : `Switchyard added the latest ${a.packageName} to package.json, since the project hadn't installed it before. Check it's the version ${a.importer} expects.`),
  );
}

export const buildStep: Step = {
  id: "build",
  title: "Build locally with cf",
  async run(ctx) {
    const dir = requireOutput(ctx, "convert", "projectDir");
    const pm = ctx.job.plan.packageManager;
    const script = ctx.output("convert").buildScript;
    const { cmd, args } = script ? runScriptCommand(pm, script) : execCommand(pm, "cf", ["build"]);
    const options = { cwd: dir, onLine: ctx.log, env: { ...productionBuildEnv(ctx), CI: "1" } };
    const warnings: string[] = [];
    for (let repairs = 0; ; repairs++) {
      const result = await ctx.deps.run(cmd, args, options);
      if (result.code === 0) break;
      const added = repairs < MAX_DEPENDENCY_REPAIRS ? await repairUndeclaredImports(ctx, dir, result.output) : [];
      if (!added.length) throw new CommandError(cmd, args, result);
      for (const w of added) ctx.log(`Warning: ${w}`);
      warnings.push(...added);
    }
    if (warnings.length) ctx.outputs.warnings = JSON.stringify(warnings);
  },
};
