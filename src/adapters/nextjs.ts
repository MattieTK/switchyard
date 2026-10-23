import { existsSync } from "node:fs";
import { appendFile, chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { satisfies, validRange } from "semver";
import { CLOUDFLARE_BUILD_SCRIPT, cloudflareBuildScript } from "../codegen/build-script.ts";
import { preapproveYarnPackages, quarantinedPackages } from "../codegen/toolchain-files.ts";
import { NEXT_UPGRADE_VERSION, VINEXT_VERSION } from "../config.ts";
import { type CommandRunner, CommandError, type RunResult, runOrThrow } from "../exec.ts";
import { allDependencies, type PackageJson, parsePackageJson } from "../translate/package-json.ts";
import {
  addCommand,
  dlxCommand,
  installCommand,
  installEnv,
  type PackageManager,
  runScriptCommand,
} from "../translate/package-manager.ts";
import { planFlaggedUpdates, type Release } from "./flagged-packages.ts";
import { type IncompatibleDependency, incompatibleDependencies, incompatibleDependencyWarning } from "./next-codemod-output.ts";
import type { Adapter, AdapterOptions, ConvertContext, NextCachePreset } from "./types.ts";

// vinext refuses to prompt when it detects an agent environment, so every
// choice is passed explicitly. "kv" is the closest match to Vercel's ISR data cache.
export const NEXT_CACHE_FLAGS: Record<NextCachePreset, readonly string[]> = {
  kv: ["--cdn-cache=data-cache", "--data-cache=kv"],
  none: ["--cdn-cache=none", "--data-cache=none"],
};

const LEGACY_PEER_DEPS_SETTING = /^\s*legacy[-_]peer[-_]deps\s*(=|$)/m;

const LEGACY_PEER_DEPS_WARNING =
  "Switchyard added legacy-peer-deps=true to .npmrc because vinext's dependencies ask for a newer React than this project pins. Check the app still works, or update React and remove the setting.";

// vinext init installs a vinext release whose React peer range can be newer than
// the project's pin, which npm rejects with ERESOLVE. Returns true when the line was added.
async function ensureLegacyPeerDeps(dir: string): Promise<boolean> {
  const path = join(dir, ".npmrc");
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing === null) {
    await writeFile(path, "legacy-peer-deps=true\n");
    return true;
  }
  if (LEGACY_PEER_DEPS_SETTING.test(existing)) return false;
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await appendFile(path, `${separator}legacy-peer-deps=true\n`);
  return true;
}

// The major version of the declared next range, such as 10 for "10.0.2" or 15 for "^15.1.0".
// Dist tags, workspace links and URLs give null, and those apps are left as they are.
function declaredNextMajor(pkg: PackageJson | null): { range: string; major: number } | null {
  const range = allDependencies(pkg).next;
  const match = range?.match(/^\s*[\^~>=<v\s]*(\d+)\./);
  return range && match ? { range, major: Number(match[1]) } : null;
}

function needsUpgrade(pkg: PackageJson | null): { range: string; major: number } | null {
  const declared = declaredNextMajor(pkg);
  return declared && declared.major < 16 ? declared : null;
}

// @next/codemod's upgrade applies cra-to-next to any app below Next.js 11, and that
// transform fails on the absolute path the upgrade gives it (16.4.1). It converts
// Create React App projects, so it never applies here, and it is the only codemod
// between 10 and 11. Starting such apps from Next.js 11 skips it.
const NEXT_11 = "11.1.4";

async function pinNext11(dir: string): Promise<void> {
  const path = join(dir, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, Record<string, string> | undefined>;
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = manifest[field];
    if (deps?.next) deps.next = NEXT_11;
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Yarn 1 answers `yarn dlx --help` with its general help and exit code 0, so
// @next/codemod 16.4.1 thinks dlx exists and its React codemods fail. While the
// upgrade runs, this wrapper goes first on PATH: it fails dlx, which makes the
// codemod fall back to npx, and passes everything else to the real yarn.
const YARN_1_WRAPPER = `#!/bin/sh
if [ "$1" = "dlx" ]; then
  echo "Yarn 1 has no dlx" >&2
  exit 1
fi
# Drop this wrapper's folder from PATH, so the real yarn runs.
PATH="\${PATH#*:}"
exec yarn "$@"
`;

// Runs fn with the Yarn 1 wrapper folder when the project uses Yarn 1, and removes it afterwards.
async function withYarn1Wrapper<T>(
  pm: PackageManager,
  run: CommandRunner,
  cwd: string,
  fn: (pathPrefix: string | undefined) => Promise<T>,
): Promise<T> {
  if (pm !== "yarn") return fn(undefined);
  const version = await run("yarn", ["--version"], { cwd });
  if (!version.stdout.trim().startsWith("1.")) return fn(undefined);
  const wrapperDir = await mkdtemp(join(tmpdir(), "switchyard-yarn-"));
  try {
    const wrapper = join(wrapperDir, "yarn");
    await writeFile(wrapper, YARN_1_WRAPPER);
    await chmod(wrapper, 0o755);
    return await fn(wrapperDir);
  } finally {
    await rm(wrapperDir, { recursive: true, force: true });
  }
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    return parsePackageJson(await readFile(join(dir, "package.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

// The nearest file called name from dir up to the repository root, or null.
function findUp(dir: string, name: string): string | null {
  for (let folder = dir; ; folder = dirname(folder)) {
    const path = join(folder, name);
    if (existsSync(path)) return path;
    if (existsSync(join(folder, ".git")) || dirname(folder) === folder) return null;
  }
}

// How many times vinext init runs again after Yarn holds packages back for their age.
// Yarn stops at the first package it holds back, so each run can find one more.
const MAX_QUARANTINE_RETRIES = 8;

// The npmPreapprovedPackages entry for a package Yarn held back. A scope belongs to one
// publisher, whose packages tend to be released together, so the whole scope is approved.
function preapprovalPattern(name: string): string {
  return name.startsWith("@") ? `${name.split("/")[0]}/*` : name;
}

// Runs a command that installs packages. Yarn 4 holds back releases newer than
// npmMinimalAgeGate, and the conversion installs packages that are often only days old
// (Cloudflare's tooling, or the latest release of a flagged package), so the install can
// fail. The packages Yarn names are added to npmPreapprovedPackages, package.json and
// yarn.lock go back to how they were, and the command runs again.
async function runInstall(
  ctx: ConvertContext,
  command: { cmd: string; args: string[] },
  env: Record<string, string>,
  warnings: string[],
  label: string,
): Promise<RunResult> {
  const read = (path: string | null) => (path ? readFile(path, "utf8").catch(() => null) : Promise.resolve(null));
  const manifestPath = join(ctx.dir, "package.json");
  const lockPath = findUp(ctx.dir, "yarn.lock");
  const [manifest, lock] = await Promise.all([read(manifestPath), read(lockPath)]);
  const yarnrc = findUp(ctx.dir, ".yarnrc.yml") ?? join(ctx.dir, ".yarnrc.yml");
  const approved: string[] = [];
  for (let attempt = 0; ; attempt++) {
    const result = await ctx.run(command.cmd, command.args, { cwd: ctx.dir, onLine: ctx.log, env });
    if (result.code === 0) {
      if (approved.length) {
        warnings.push(
          `Switchyard added ${approved.join(", ")} to npmPreapprovedPackages in ${relative(ctx.dir, yarnrc)}, because Yarn held back these releases as newer than npmMinimalAgeGate and the conversion needs them. Remove the entries if you'd rather wait for those releases to age.`,
        );
      }
      return result;
    }
    const quarantined = ctx.pm === "yarn" ? quarantinedPackages(result.output) : [];
    const blocked = [...new Set(quarantined.map(preapprovalPattern))].filter((p) => !approved.includes(p));
    if (!blocked.length || attempt >= MAX_QUARANTINE_RETRIES) throw new CommandError(command.cmd, command.args, result);
    const updated = preapproveYarnPackages((await read(yarnrc)) ?? "", blocked);
    if (!updated) {
      ctx.log(
        `Warning: Yarn held back ${blocked.join(", ")} as newer than npmMinimalAgeGate. npmPreapprovedPackages in ${relative(ctx.dir, yarnrc)} is an inline list Switchyard can't extend, so add them to it and retry.`,
      );
      throw new CommandError(command.cmd, command.args, result);
    }
    await writeFile(yarnrc, updated.text);
    if (manifest !== null) await writeFile(manifestPath, manifest);
    if (lockPath && lock !== null) await writeFile(lockPath, lock);
    approved.push(...blocked);
    ctx.log(
      `Yarn held back ${blocked.join(", ")} as too new, so Switchyard added ${blocked.length === 1 ? "it" : "them"} to npmPreapprovedPackages and is running ${label} again.`,
    );
  }
}

interface InstalledPackage {
  version?: string;
  peerDependencies?: Record<string, string>;
}

// The package.json Node would load for name from dir, looking in parent folders too,
// since workspaces often install packages at the repository root.
async function installedPackage(dir: string, name: string): Promise<InstalledPackage | null> {
  for (let folder = dir; ; folder = dirname(folder)) {
    try {
      return JSON.parse(await readFile(join(folder, "node_modules", name, "package.json"), "utf8")) as InstalledPackage;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(folder) === folder) return null;
  }
}

// vinext init installs the newest vinext 1.x, whose peer dependencies (React, the Vite
// plugins) can be newer than the app has, and it doesn't update them. vinext's App Router
// build stops below its React range, for example. Updates each installed peer that is
// outside vinext's range and returns a warning for each.
async function updateVinextPeers(ctx: ConvertContext, env: Record<string, string>): Promise<string[]> {
  const peers = Object.entries((await installedPackage(ctx.dir, "vinext"))?.peerDependencies ?? {});
  const outdated: { name: string; version: string; range: string }[] = [];
  for (const [name, range] of peers) {
    const version = (await installedPackage(ctx.dir, name))?.version;
    // A peer the app doesn't have is optional for it, so it's left out.
    if (version && validRange(range) && !satisfies(version, range, { includePrerelease: true })) {
      outdated.push({ name, version, range });
    }
  }
  if (!outdated.length) return [];
  const add = addCommand(ctx.pm, outdated.map((p) => `${p.name}@${p.range}`));
  await runOrThrow(ctx.run, add.cmd, add.args, { cwd: ctx.dir, onLine: ctx.log, env });
  return outdated.map(
    (p) =>
      `Switchyard updated ${p.name} from ${p.version} to ${p.range}, because vinext needs a version in that range. Check the app still works with it.`,
  );
}

// The registry's releases of a package after version, or null when they can't be read. npm
// comes with Node and reads the project's .npmrc, so private registries work too. It prints a
// list for several releases, an object for one, and only the version string for a release
// without peers, and fails with "No match found" when there is none.
async function newerReleases(ctx: ConvertContext, name: string, version: string): Promise<Release[] | null> {
  const result = await ctx.run("npm", ["view", `${name}@>${version}`, "version", "peerDependencies", "--json"], { cwd: ctx.dir });
  if (result.code !== 0) return result.stdout.includes("No match found") ? [] : null;
  const toRelease = (entry: unknown): Release | null => {
    if (typeof entry === "string") return { version: entry };
    const r = entry as Partial<Release> | null;
    return typeof r?.version === "string" ? { version: r.version, peerDependencies: r.peerDependencies ?? {} } : null;
  };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const releases = (Array.isArray(parsed) ? parsed : [parsed]).map(toRelease);
    return releases.every((r) => r !== null) ? releases : null;
  } catch {
    return null;
  }
}

// Updates the packages the upgrade flagged as incompatible to their first release that
// supports what the upgrade installed. Returns a warning for each package.
async function updateFlaggedPackages(
  ctx: ConvertContext,
  flagged: readonly IncompatibleDependency[],
  env: Record<string, string>,
  warnings: string[],
): Promise<string[]> {
  if (!flagged.length) return [];
  const direct = allDependencies(await readPackageJson(ctx.dir));
  const newer = new Map<string, Release[] | null>();
  for (const p of flagged) if (p.name in direct) newer.set(p.name, await newerReleases(ctx, p.name, p.version));
  const plan = planFlaggedUpdates(flagged, direct, newer);
  if (plan.updates.length) {
    const add = addCommand(ctx.pm, plan.updates.map((u) => `${u.name}@${u.to}`));
    await runInstall(ctx, add, env, warnings, "the update").catch((error: unknown) => {
      throw new Error(
        `Updating ${plan.updates.map((u) => u.name).join(", ")} failed (${(error as Error).message}). Check the log, or build the plan again without Update flagged packages.`,
      );
    });
  }
  return plan.warnings;
}

// vinext init sets "type": "module" so its Vite config loads as an ES module. That also
// makes every other .js file in the project an ES module, and CommonJS scripts it doesn't
// rename to .cjs (a prebuild tool, a custom server) then fail with "require is not defined".
// A .mts or .mjs Vite config loads as an ES module whatever the type, so the project keeps its own.
async function restoreModuleType(dir: string, typeBefore: string | undefined): Promise<void> {
  if (typeBefore === "module") return;
  const path = join(dir, "package.json");
  const text = await readFile(path, "utf8").catch(() => null);
  const manifest = text === null ? null : (JSON.parse(text) as { type?: string });
  if (manifest?.type !== "module") return;
  const config = [
    ["vite.config.ts", "vite.config.mts"],
    ["vite.config.js", "vite.config.mjs"],
  ].find(([from = ""]) => existsSync(join(dir, from)));
  if (!config) return;
  const [from = "", to = ""] = config;
  await rename(join(dir, from), join(dir, to));
  if (typeBefore === undefined) delete manifest.type;
  else manifest.type = typeBefore;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Writes the build:cloudflare script when the app's build runs steps before next build.
// Returns the script's name, or null when cf build alone does the same.
async function writeCloudflareBuildScript(ctx: ConvertContext, warnings: string[]): Promise<string | null> {
  const path = join(ctx.dir, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as { scripts?: Record<string, string> };
  const run = (name: string) => {
    const c = runScriptCommand(ctx.pm, name);
    return [c.cmd, ...c.args].join(" ");
  };
  const result = cloudflareBuildScript(manifest.scripts, run);
  warnings.push(...result.warnings);
  if (!result.script) return null;
  manifest.scripts = { ...manifest.scripts, [CLOUDFLARE_BUILD_SCRIPT]: result.script };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  warnings.push(
    `cf build doesn't run the app's build script, so Switchyard added a ${CLOUDFLARE_BUILD_SCRIPT} script (\`${result.script}\`) that keeps its other build steps, and Workers Builds runs that script.`,
  );
  return CLOUDFLARE_BUILD_SCRIPT;
}

const NEXT_CONFIG_FILES = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs", "next.config.mts"];
// output: "standalone", including conditional values such as `ci ? undefined : "standalone"`,
// and assignments such as nextConfig.output = "standalone".
const STANDALONE_OUTPUT = /\boutput\s*[:=][^,;\n}]*["'`]standalone["'`]/;

const VITE_CONFIG_FILES = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];
const STUB_FILE = "empty-stub.js";
const STUB_ALIAS = /["']([^"']+)["']\s*:\s*\w+\.resolve\(__dirname,\s*["']empty-stub\.js["']\)/g;

// vinext init points native modules such as sharp at empty-stub.js, which Workers can't
// load, but doesn't create the file (cloudflare/vinext#4196), so the build fails. Creates
// it and returns a warning naming the modules, which do nothing on Workers.
async function createVinextStub(dir: string): Promise<string | null> {
  for (const name of VITE_CONFIG_FILES) {
    const config = await readFile(join(dir, name), "utf8").catch(() => null);
    const modules = config ? [...config.matchAll(STUB_ALIAS)].map((m) => m[1]) : [];
    if (!modules.length || existsSync(join(dir, STUB_FILE))) continue;
    await writeFile(
      join(dir, STUB_FILE),
      "// Stands in for Node.js-only modules that can't run on Workers. vinext init points them here.\nexport default {};\n",
    );
    return `vinext replaces ${modules.join(", ")} with an empty module (${STUB_FILE}), because ${modules.length === 1 ? "it needs" : "they need"} Node.js. Code that calls ${modules.length === 1 ? "it" : "them"} at runtime won't work on Workers.`;
  }
  return null;
}

// cf build sets this for the Cloudflare build only.
const CLOUDFLARE_BUILD_ENV = "CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT";

// vinext writes standalone output from dist/ after a build, but cf build puts the output in
// .cloudflare/output, so a Cloudflare build with output: "standalone" fails (a vinext bug).
// Makes the standalone value apply only outside the Cloudflare build, so next build and
// Docker images keep it. Returns a warning when next.config changed.
async function standaloneOutsideCloudflare(dir: string): Promise<string | null> {
  for (const name of NEXT_CONFIG_FILES) {
    const path = join(dir, name);
    const text = await readFile(path, "utf8").catch(() => null);
    const match = text === null ? null : STANDALONE_OUTPUT.exec(text);
    if (text === null || !match || match[0].includes(CLOUDFLARE_BUILD_ENV)) continue;
    const setting = match[0].replace(
      /(["'`])standalone\1/,
      (literal) => `(process.env.${CLOUDFLARE_BUILD_ENV} ? undefined : ${literal})`,
    );
    await writeFile(path, text.slice(0, match.index) + setting + text.slice(match.index + match[0].length));
    return `${name} set output: "standalone", which vinext's Cloudflare build can't produce. Switchyard made it apply only outside the Cloudflare build (when ${CLOUDFLARE_BUILD_ENV} isn't set), so next build and Docker images still get standalone output.`;
  }
  return null;
}

// cf picks the framework to build itself, and cloudflare.config.ts can't name it. With one
// of these dependencies beside Next.js and Vite, it finds more than one framework and stops.
// Checked against cf 1.0.0-beta.20, which reads them from package.json.
const CF_DETECTED_FRAMEWORKS: Readonly<Record<string, string>> = {
  hono: "Hono",
  astro: "Astro",
  nuxt: "Nuxt",
  "@sveltejs/kit": "SvelteKit",
  "@builder.io/qwik": "Qwik",
  "@solidjs/start": "Solid Start",
  "@tanstack/react-start": "TanStack Start",
  vike: "Vike",
  waku: "Waku",
  "@analogjs/platform": "Analog",
};

// The upgrade applies only the migrations Next.js 16 requires unless the user opted into more.
function upgradeFlags(options: AdapterOptions): string[] {
  return [
    ...(options.adoptionCodemods ? [] : ["--skip-adoption"]),
    ...(options.eslintMigration ? [] : ["--skip-eslint-upgrade"]),
  ];
}

const OPTIONAL_UPGRADE_STEPS = { adoptionCodemods: "Adoption codemods", eslintMigration: "ESLint migration" } as const;

// Names the opt-ins that ran in a failed upgrade, since leaving them out is the user's next try.
function upgradeError(command: { cmd: string; args: string[] }, result: RunResult, options: AdapterOptions): Error {
  const chosen = (Object.keys(OPTIONAL_UPGRADE_STEPS) as (keyof typeof OPTIONAL_UPGRADE_STEPS)[])
    .filter((o) => options[o])
    .map((o) => OPTIONAL_UPGRADE_STEPS[o]);
  if (!chosen.length) return new CommandError(command.cmd, command.args, result);
  return new Error(
    `The Next.js upgrade failed with ${chosen.join(" and ")} chosen. Check the log, or build the plan again without ${chosen.length === 1 ? "it" : "them"}.`,
  );
}

// Next.js 16 removed next lint, so scripts that run it fail until the ESLint migration runs.
async function nextLintWarnings(dir: string): Promise<string[]> {
  const scripts = (await readPackageJsonScripts(dir)) ?? {};
  const linting = Object.entries(scripts).filter(([, command]) => /\bnext\s+lint\b/.test(command));
  return linting.length
    ? [
        `The ${linting.map(([name]) => name).join(", ")} script${linting.length === 1 ? " runs" : "s run"} next lint, which Next.js 16 removed. Choose ESLint migration under Upgrade options, or change ${linting.length === 1 ? "it" : "them"} to run eslint directly.`,
      ]
    : [];
}

async function readPackageJsonScripts(dir: string): Promise<Record<string, string> | null> {
  const text = await readFile(join(dir, "package.json"), "utf8").catch(() => null);
  if (text === null) return null;
  const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
  return scripts && typeof scripts === "object" ? (scripts as Record<string, string>) : null;
}

export const nextjsAdapter: Adapter = {
  id: "nextjs",
  label: "Next.js (vinext)",
  support: { level: "supported" },
  reservedBindings: ["ASSETS", "IMAGES", "VINEXT_KV_CACHE"],
  matches: (input) => input.vercelFramework === "nextjs" || "next" in allDependencies(input.packageJson),
  upgradeFor(packageJson) {
    const old = needsUpgrade(packageJson);
    return old ? { from: old.range, to: NEXT_UPGRADE_VERSION } : null;
  },
  planFiles: NEXT_CONFIG_FILES,
  planWarnings(packageJson, files) {
    const warnings: string[] = [];
    const old = needsUpgrade(packageJson);
    if (old) {
      warnings.push(
        `This app uses Next.js ${old.major}. Switchyard will upgrade it to Next.js ${NEXT_UPGRADE_VERSION} with the official Next.js codemods before converting, because vinext needs Next.js 16. Only the required migrations run unless you choose more under Upgrade options. Upgrading across major versions can change how the app behaves, so review the pull request and test the preview before switching traffic.`,
      );
    }
    const dependencies = allDependencies(packageJson);
    const others = Object.entries(CF_DETECTED_FRAMEWORKS).filter(([name]) => name in dependencies);
    if (others.length) {
      const names = others.map(([, framework]) => framework).join(", ");
      warnings.push(
        `This app depends on ${others.map(([name]) => name).join(", ")}, so the Cloudflare build tool (cf) finds ${names} as well as Next.js and Vite. It can't choose between them and stops, so the build will fail. This is a bug in cf that Switchyard can't work around at this point.`,
      );
    }
    // vinext then writes a Node.js server from a build output the Cloudflare build doesn't produce.
    const config = NEXT_CONFIG_FILES.map((f) => files[f]).find((text) => text !== undefined);
    if (config && STANDALONE_OUTPUT.test(config)) {
      warnings.push(
        'next.config sets output: "standalone", which vinext\'s Cloudflare build can\'t produce. Switchyard will make it apply only outside the Cloudflare build, so next build and Docker images keep standalone output.',
      );
    }
    return warnings;
  },
  async convert(ctx) {
    const warnings: string[] = [];
    if (ctx.pm === "npm" && (await ensureLegacyPeerDeps(ctx.dir))) warnings.push(LEGACY_PEER_DEPS_WARNING);
    const env = installEnv(ctx.pm);

    const typeBefore = await readFile(join(ctx.dir, "package.json"), "utf8").then(
      (text) => (JSON.parse(text) as { type?: string }).type,
      () => undefined,
    );
    const old = needsUpgrade(await readPackageJson(ctx.dir));
    if (old) {
      if (old.major < 11) await pinNext11(ctx.dir);
      // The upgrade reads the installed Next.js and React versions, so dependencies go in first.
      const install = installCommand(ctx.pm);
      await runOrThrow(ctx.run, install.cmd, install.args, { cwd: ctx.dir, onLine: ctx.log, env });
      const upgrade = dlxCommand(ctx.pm, `@next/codemod@${NEXT_UPGRADE_VERSION}`, [
        "upgrade",
        NEXT_UPGRADE_VERSION,
        "--yes",
        ...upgradeFlags(ctx.options),
      ]);
      const upgraded = await withYarn1Wrapper(ctx.pm, ctx.run, ctx.dir, (pathPrefix) =>
        ctx.run(upgrade.cmd, upgrade.args, {
          cwd: ctx.dir,
          onLine: ctx.log,
          // The codemod picks a package manager from the user agent before the lockfile,
          // and npx would otherwise make it npm.
          env: { ...env, npm_config_user_agent: `${ctx.pm}/switchyard` },
          ...(pathPrefix ? { pathPrefix } : {}),
        }),
      );
      if (upgraded.code !== 0) throw upgradeError(upgrade, upgraded, ctx.options);
      warnings.push(
        `Switchyard upgraded Next.js from ${old.range} to ${NEXT_UPGRADE_VERSION} with the official Next.js codemods. The codemods don't cover every breaking change, so review the pull request and test the preview before switching traffic.`,
      );
      const flagged = incompatibleDependencies(upgraded.output);
      if (ctx.options.updateFlaggedPackages) warnings.push(...(await updateFlaggedPackages(ctx, flagged, env, warnings)));
      else warnings.push(...flagged.map(incompatibleDependencyWarning));
      if (!ctx.options.eslintMigration) warnings.push(...(await nextLintWarnings(ctx.dir)));
    }
    const { cmd, args } = dlxCommand(ctx.pm, `vinext@${VINEXT_VERSION}`, [
      "init",
      "--platform=cloudflare",
      ...NEXT_CACHE_FLAGS[ctx.options.nextCache],
      "--image-optimization=cloudflare-images",
    ]);
    const result = await runInstall(ctx, { cmd, args }, env, warnings, "vinext init");
    await restoreModuleType(ctx.dir, typeBefore);
    const stubWarning = await createVinextStub(ctx.dir);
    if (stubWarning) warnings.push(stubWarning);
    const standaloneWarning = await standaloneOutsideCloudflare(ctx.dir);
    if (standaloneWarning) warnings.push(standaloneWarning);
    warnings.push(...(await updateVinextPeers(ctx, env)));
    if (result.output.includes("approve-builds")) {
      warnings.push(
        "pnpm blocked some dependency build scripts during install. If the Cloudflare build fails, run `pnpm approve-builds` in the project and commit the result.",
      );
    }
    const buildScript = await writeCloudflareBuildScript(ctx, warnings);
    return { baseEntrypoint: "vinext/server/fetch-handler", warnings, ...(buildScript ? { buildScript } : {}) };
  },
};
