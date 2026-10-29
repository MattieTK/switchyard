import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { NO_PROJECT_SETTINGS } from "../../adapters/types.ts";
import { gitAuthEnv } from "../../auth/github.ts";
import { editCloudflareConfig } from "../../codegen/config-edit.ts";
import { CRON_ENTRY_FILE, cronEntrySource } from "../../codegen/cron-entry.ts";
import { addGitignoreEntries } from "../../codegen/gitignore.ts";
import { useNativeFetch } from "../../codegen/native-fetch.ts";
import {
  allowBuildsIn,
  approveBuilds,
  ignoredBuildsFrom,
  isYarn1Lockfile,
  MIN_NODE_MAJOR,
  NODE_VERSION_FILES,
  raiseNodeVersion,
  undecidedBuilds,
  YARN_1_VERSION,
} from "../../codegen/toolchain-files.ts";
import { MIGRATION_BRANCH } from "../../config.ts";
import { CommandError, runOrThrow } from "../../exec.ts";
import { devVarsFile, secretKeys } from "../../translate/env-plan.ts";
import { parsePackageJson } from "../../translate/package-json.ts";
import {
  addCommand,
  execCommand,
  IMPORTABLE_LOCKFILES,
  installEnv,
  OTHER_LOCKFILES,
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
// whether the production branch's lockfile already had a package; ignored lists the packages
// whose build scripts pnpm 12 skipped without writing a placeholder; switchedFrom is the
// package manager the project used before Switchyard moved it to pnpm.
async function updateToolchainFiles(
  projectDir: string,
  repoDir: string,
  installedBefore: (name: string) => Promise<boolean>,
  ignored: readonly string[] = [],
  switchedFrom?: PackageManager,
): Promise<string[]> {
  const warnings: string[] = [];
  const folders = [...new Set([projectDir, repoDir])];
  const read = (path: string) => readFile(path, "utf8").catch(() => null);
  const builds = buildDecisions(installedBefore, switchedFrom);
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
    // pnpm 11 marks the packages it wants a decision on with a placeholder.
    const { added, existing } = await builds.split(undecidedBuilds(workspace));
    if (!added.length && !existing.length) continue;
    await writeFile(workspacePath, approveBuilds(approveBuilds(workspace, added), existing, builds.allowExisting));
    const file = relative(repoDir, workspacePath);
    if (added.length) warnings.push(builds.addedWarning(added, file));
    if (existing.length) warnings.push(builds.existingWarning(existing, file));
  }
  if (ignored.length) warnings.push(...(await decideIgnoredBuilds(folders, projectDir, repoDir, builds, ignored)));
  return warnings;
}

// How Switchyard decides on build scripts pnpm skipped, so Workers Builds' install doesn't stop.
// Packages the conversion added (vinext's toolchain, such as workerd, and whatever the Next.js
// upgrade brings) are part of Switchyard's change, so they're allowed. The project's own keep
// what happened on Vercel: yarn, npm and bun run every build script, so a project moved to pnpm
// allows them, while pnpm already skipped them for a project that was on pnpm.
function buildDecisions(installedBefore: (name: string) => Promise<boolean>, switchedFrom?: PackageManager) {
  return {
    allowExisting: switchedFrom !== undefined,
    async split(names: readonly string[]) {
      const added: string[] = [];
      const existing: string[] = [];
      for (const name of names) (await installedBefore(name) ? existing : added).push(name);
      return { added, existing };
    },
    addedWarning: (names: readonly string[], file: string) =>
      `Switchyard allowed the build scripts of ${names.join(", ")} in ${file}. The conversion added these packages, and pnpm stops installing until each build script is allowed or refused. Change any to false if you'd rather not run it.`,
    existingWarning: (names: readonly string[], file: string) =>
      switchedFrom
        ? `Switchyard allowed the build scripts of ${names.join(", ")} in ${file}, because ${switchedFrom} ran them when Vercel installed the project, and pnpm stops installing until each is allowed or refused. Change any to false if the app doesn't need it.`
        : `Switchyard set the build scripts of ${names.join(", ")} to false in ${file}, because pnpm already skipped them before the migration, and pnpm stops installing until each is allowed or refused. Change any to true if the app needs it.`,
  };
}

// pnpm 12 skips build scripts without writing a placeholder, and Workers Builds' install, run
// with CI set, then fails with ERR_PNPM_IGNORED_BUILDS. The entries go in the workspace file
// pnpm reads (the project's, else the repository root's), or a new one in a single-project
// repository; a new one in a monorepo's subfolder would change the workspace.
async function decideIgnoredBuilds(
  folders: readonly string[],
  projectDir: string,
  repoDir: string,
  builds: ReturnType<typeof buildDecisions>,
  ignored: readonly string[],
): Promise<string[]> {
  const undecided = (names: readonly string[], file: string) =>
    `pnpm skipped the build scripts of ${names.join(", ")}. Workers Builds installs with CI set, where pnpm stops until each is listed under allowBuilds in ${file} as true or false, so decide before merging.`;
  const folder = folders.find((f) => existsSync(join(f, "pnpm-workspace.yaml"))) ?? (projectDir === repoDir ? projectDir : null);
  if (!folder) return [undecided(ignored, "the workspace's pnpm-workspace.yaml")];
  const path = join(folder, "pnpm-workspace.yaml");
  const file = relative(repoDir, path);
  const text = await readFile(path, "utf8").catch(() => "");
  const { added, existing } = await builds.split(ignored);
  const allowed = allowBuildsIn(text, added);
  const decided = allowed && allowBuildsIn(allowed.text, existing, builds.allowExisting);
  // An allowBuilds list written inline can't be extended safely, so the user decides.
  if (!allowed || !decided) return [undecided(ignored, file)];
  if (decided.text !== text) await writeFile(path, decided.text);
  return [
    ...(allowed.added.length ? [builds.addedWarning(allowed.added, file)] : []),
    ...(decided.added.length ? [builds.existingWarning(decided.added, file)] : []),
  ];
}

// Removes lockfiles of package managers the project doesn't use. vinext and cf choose a
// package manager from the lockfiles they find, so a stray yarn.lock in a pnpm project
// makes them run Yarn. Returns a warning when anything was removed.
async function removeOtherLockfiles(dir: string, pm: PackageManager): Promise<string | null> {
  const other = [...Object.values(LOCKFILES).flat(), "bun.lockb"].filter(
    (f) => !LOCKFILES[pm].includes(f) && !(pm === "bun" && f === "bun.lockb") && existsSync(join(dir, f)),
  );
  if (!other.length) return null;
  for (const f of other) await rm(join(dir, f), { force: true });
  return `The project had lockfiles for more than one package manager. Switchyard kept ${pm}'s, the one it detected, and removed ${other.join(", ")}, because the Cloudflare build tools could otherwise pick another package manager.`;
}

// Keeps a Yarn 1 project on Yarn 1 everywhere by naming it in package.json. Returns a
// warning when package.json changed.
async function pinYarn1(projectDir: string, repoDir: string): Promise<string | null> {
  const path = join(projectDir, "package.json");
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null || parsePackageJson(text)?.packageManager) return null;
  for (const folder of new Set([projectDir, repoDir])) {
    const lock = await readFile(join(folder, "yarn.lock"), "utf8").catch(() => null);
    if (lock === null) continue;
    if (!isYarn1Lockfile(lock)) return null;
    const manifest = JSON.parse(text) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...manifest, packageManager: `yarn@${YARN_1_VERSION}` }, null, 2)}\n`);
    return `Switchyard set packageManager to yarn@${YARN_1_VERSION} in package.json. The project has a Yarn 1 lockfile, which Vercel installs with Yarn 1, while Workers Builds would otherwise use Yarn 4 and switch the project to Plug'n'Play.`;
  }
  return null;
}

// Files only Yarn uses, which a project moved to pnpm no longer needs.
const YARN_FILES = [".yarnrc.yml", ".yarn", ".pnp.cjs", ".pnp.loader.mjs"];

// Moves the project to pnpm, which the user chose on the plan screen. pnpm import keeps the
// versions in an npm or Yarn lockfile. A bun lockfile can't be imported, so pnpm resolves
// versions again, as the plan said. Returns warnings for the pull request.
async function switchToPnpm(ctx: StepContext, dir: string, from: PackageManager): Promise<string[]> {
  await ctx.deps.ensurePackageManager("pnpm", dir, ctx.log);
  const locks = OTHER_LOCKFILES.filter((f) => existsSync(join(dir, f)));
  const imported = locks.find((f) => IMPORTABLE_LOCKFILES.includes(f));
  if (imported) {
    const result = await ctx.deps.run("pnpm", ["import"], { cwd: dir, onLine: ctx.log, env: installEnv("pnpm") });
    if (result.code !== 0) {
      throw new Error(
        `pnpm couldn't import ${imported} (pnpm import exited with code ${result.code}). Check the log, or build the plan again without Switch to pnpm.`,
      );
    }
  }
  for (const lock of locks) await rm(join(dir, lock), { force: true });
  // npm, Yarn and bun put every package at the top of node_modules, so apps often import
  // packages they don't declare. Hoisting keeps those working under pnpm. pnpm 11 reads the
  // setting from pnpm-workspace.yaml and pnpm 10, Workers Builds' default, from .npmrc.
  const workspacePath = join(dir, "pnpm-workspace.yaml");
  const workspace = await readFile(workspacePath, "utf8").catch(() => "");
  if (!/^shamefullyHoist:/m.test(workspace)) {
    await writeFile(workspacePath, `${workspace}${workspace && !workspace.endsWith("\n") ? "\n" : ""}shamefullyHoist: true\n`);
  }
  const npmrcPath = join(dir, ".npmrc");
  const npmrc = await readFile(npmrcPath, "utf8").catch(() => "");
  if (!/^\s*shamefully-hoist\s*=/m.test(npmrc)) {
    await writeFile(npmrcPath, `${npmrc}${npmrc && !npmrc.endsWith("\n") ? "\n" : ""}shamefully-hoist=true\n`);
  }
  const version = (await ctx.deps.run("pnpm", ["--version"], { cwd: dir })).stdout.trim();
  const manifestPath = join(dir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { packageManager?: string; scripts?: Record<string, string> };
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, packageManager: `pnpm@${version}` }, null, 2)}\n`);

  const warnings = [
    imported
      ? `Switchyard moved the project from ${from} to pnpm with pnpm import, which keeps the dependency versions from ${imported}, and set packageManager to pnpm@${version}.`
      : `Switchyard moved the project from ${from} to pnpm and set packageManager to pnpm@${version}. ${locks.length ? `${locks.join(" and ")} can't be imported` : "There was no lockfile"}, so pnpm chose dependency versions again. Test the app before merging.`,
    `Switchyard turned on shamefullyHoist in pnpm-workspace.yaml and .npmrc, so packages the app imports without declaring stay reachable, as they were with ${from}. Once package.json lists everything the app imports, you can remove it.`,
  ];
  const otherManagers = Object.entries(manifest.scripts ?? {}).filter(([, command]) => /(^|[\s&|;(])(yarn|bunx?)(\s|$)/.test(command));
  if (otherManagers.length) {
    warnings.push(
      `The ${otherManagers.map(([name]) => name).join(", ")} script${otherManagers.length === 1 ? " calls" : "s call"} yarn or bun directly. Change ${otherManagers.length === 1 ? "it" : "them"} to use pnpm.`,
    );
  }
  const leftovers = YARN_FILES.filter((f) => existsSync(join(dir, f)));
  if (leftovers.length) warnings.push(`pnpm doesn't use ${leftovers.join(", ")}. Remove ${leftovers.length === 1 ? "it" : "them"} once the move is settled.`);
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
    const switchWarnings = plan.switchedFrom ? await switchToPnpm(ctx, dir, plan.switchedFrom) : [];
    const yarnWarning = plan.packageManager === "yarn" ? await pinYarn1(dir, repoDir) : null;
    const lockWarning = await removeOtherLockfiles(dir, plan.packageManager);
    await ctx.deps.ensurePackageManager(plan.packageManager, dir, ctx.log);
    const result = await adapter.convert({
      dir,
      workerName: plan.workerName,
      settings: plan.settings ?? NO_PROJECT_SETTINGS,
      pm: plan.packageManager,
      run: ctx.deps.run,
      log: ctx.log,
      options: {
        nextCache: plan.nextCache,
        adoptionCodemods: plan.options?.adoptionCodemods ?? false,
        eslintMigration: plan.options?.eslintMigration ?? false,
        updateFlaggedPackages: plan.options?.updateFlaggedPackages ?? false,
      },
    });
    const warnings = [
      ...switchWarnings,
      ...(yarnWarning ? [yarnWarning] : []),
      ...(lockWarning ? [lockWarning] : []),
      ...result.warnings,
      ...(await replaceFetchPolyfills(ctx, dir)),
      ...(await updateToolchainFiles(
        dir,
        repoDir,
        async (name) => (await versionBeforeMigration(ctx, name)) !== null,
        plan.packageManager === "pnpm" ? await pnpmIgnoredBuilds(ctx, dir) : [],
        plan.switchedFrom,
      )),
    ];
    for (const w of warnings) ctx.log(`Warning: ${w}`);

    const configPath = join(dir, "cloudflare.config.ts");
    const source = await readFile(configPath, "utf8").catch(() => {
      throw new Error("The converter didn't create cloudflare.config.ts.");
    });
    // Cron routes need the app's own Worker entry to call. The plan leaves crons out for
    // Workers that only serve static assets, so this is only a safeguard.
    const crons = result.baseEntrypoint ? plan.vercelJson.crons : [];
    if (plan.vercelJson.crons.length && !crons.length) {
      ctx.log("Warning: the converted app has no Worker entry for cron jobs to call, so they weren't moved.");
    }
    if (result.baseEntrypoint && crons.length) {
      await writeFile(join(dir, CRON_ENTRY_FILE), cronEntrySource(result.baseEntrypoint, crons));
    }
    await writeFile(
      configPath,
      editCloudflareConfig(source, {
        workerName: plan.workerName,
        secretKeys: secretKeys(plan.env),
        crons,
        entrypoint: crons.length ? `./${CRON_ENTRY_FILE}` : undefined,
        ...(result.compatibilityFlags ? { compatibilityFlags: result.compatibilityFlags } : {}),
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
const SOURCE_FILES = ["*.js", "*.jsx", "*.ts", "*.tsx", "*.mjs", "*.cjs"];

// Rewrites imports of fetch polyfills in the project's tracked source files to use the fetch
// built into Workers (see FETCH_POLYFILLS). Returns warnings naming the files it changed and
// those that still import a polyfill in a way it couldn't replace exactly.
async function replaceFetchPolyfills(ctx: StepContext, dir: string): Promise<string[]> {
  const listed = await ctx.deps.run("git", ["ls-files", "-z", "--", ...SOURCE_FILES], { cwd: dir });
  if (listed.code !== 0) return [];
  const changed = new Map<string, string[]>();
  const kept = new Map<string, string[]>();
  for (const file of listed.output.split("\0").filter((f) => SOURCE_FILES.some((p) => f.endsWith(p.slice(1))))) {
    const path = join(dir, file);
    const code = await readFile(path, "utf8").catch(() => null);
    if (code === null) continue;
    const result = useNativeFetch(code, file);
    if (result.code !== null) {
      await writeFile(path, result.code);
      changed.set(file, result.replaced);
    }
    if (result.kept.length) kept.set(file, result.kept);
  }
  const unique = (lists: Iterable<string[]>) => [...new Set([...lists].flat())];
  const warnings: string[] = [];
  if (changed.size) {
    const packages = unique(changed.values());
    warnings.push(
      `Switchyard replaced the imports of ${packages.join(", ")} in ${[...changed.keys()].join(", ")} with the fetch built into Workers. These packages fill in fetch where a platform lacked it, and their Node.js versions can break once bundled for Workers (isomorphic-fetch fails with "n.call is not a function"). You can remove ${packages.length === 1 ? "it" : "them"} from package.json once nothing else imports ${packages.length === 1 ? "it" : "them"}.`,
    );
  }
  for (const [file, packages] of kept) {
    warnings.push(
      `${file} still imports ${packages.join(", ")} in a way Switchyard didn't rewrite. If it fails on Workers, use the built-in fetch there instead.`,
    );
  }
  return warnings;
}

// The packages whose build scripts pnpm skipped in the converted project. Older pnpm releases
// without the command, or a failure, count as none.
async function pnpmIgnoredBuilds(ctx: StepContext, dir: string): Promise<string[]> {
  const result = await ctx.deps.run("pnpm", ["ignored-builds"], { cwd: dir }).catch(() => null);
  return result && result.code === 0 ? ignoredBuildsFrom(result.output) : [];
}

async function versionBeforeMigration(ctx: StepContext, name: string): Promise<string | null> {
  const repo = requireRepo(ctx.job.plan);
  const repoDir = requireOutput(ctx, "clone", "dir");
  const folders = [...new Set([repo.rootDirectory, ""])];
  for (const folder of folders) {
    // A project moved to pnpm had its original manager's lockfile on the production branch.
    for (const file of LOCKFILES[ctx.job.plan.switchedFrom ?? ctx.job.plan.packageManager]) {
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
