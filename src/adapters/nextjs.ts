import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { satisfies, validRange } from "semver";
import { NEXT_UPGRADE_VERSION, VINEXT_VERSION } from "../config.ts";
import { type CommandRunner, runOrThrow } from "../exec.ts";
import { allDependencies, type PackageJson, parsePackageJson } from "../translate/package-json.ts";
import {
  addCommand,
  dlxCommand,
  installCommand,
  installEnv,
  type PackageManager,
} from "../translate/package-manager.ts";
import { incompatibleDependencyWarnings } from "./next-codemod-output.ts";
import type { Adapter, ConvertContext, NextCachePreset } from "./types.ts";

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

export const nextjsAdapter: Adapter = {
  id: "nextjs",
  label: "Next.js (vinext)",
  support: { level: "supported" },
  reservedBindings: ["ASSETS", "IMAGES", "VINEXT_KV_CACHE"],
  matches: (input) => input.vercelFramework === "nextjs" || "next" in allDependencies(input.packageJson),
  planWarnings(packageJson) {
    const old = needsUpgrade(packageJson);
    return old
      ? [
          `This app uses Next.js ${old.major}. Switchyard will upgrade it to Next.js ${NEXT_UPGRADE_VERSION} with the official Next.js codemods before converting, because vinext needs Next.js 16. Upgrading across major versions can change how the app behaves, so review the pull request and test the preview before switching traffic.`,
        ]
      : [];
  },
  async convert(ctx) {
    const warnings: string[] = [];
    if (ctx.pm === "npm" && (await ensureLegacyPeerDeps(ctx.dir))) warnings.push(LEGACY_PEER_DEPS_WARNING);
    const env = installEnv(ctx.pm);

    const old = needsUpgrade(await readPackageJson(ctx.dir));
    if (old) {
      if (old.major < 11) await pinNext11(ctx.dir);
      // The upgrade reads the installed Next.js and React versions, so dependencies go in first.
      const install = installCommand(ctx.pm);
      await runOrThrow(ctx.run, install.cmd, install.args, { cwd: ctx.dir, onLine: ctx.log, env });
      const upgrade = dlxCommand(ctx.pm, `@next/codemod@${NEXT_UPGRADE_VERSION}`, ["upgrade", NEXT_UPGRADE_VERSION, "--yes"]);
      const upgraded = await withYarn1Wrapper(ctx.pm, ctx.run, ctx.dir, (pathPrefix) =>
        runOrThrow(ctx.run, upgrade.cmd, upgrade.args, {
          cwd: ctx.dir,
          onLine: ctx.log,
          // The codemod picks a package manager from the user agent before the lockfile,
          // and npx would otherwise make it npm.
          env: { ...env, npm_config_user_agent: `${ctx.pm}/switchyard` },
          ...(pathPrefix ? { pathPrefix } : {}),
        }),
      );
      warnings.push(
        `Switchyard upgraded Next.js from ${old.range} to ${NEXT_UPGRADE_VERSION} with the official Next.js codemods. The codemods don't cover every breaking change, so review the pull request and test the preview before switching traffic.`,
        ...incompatibleDependencyWarnings(upgraded.output),
      );
    }
    const { cmd, args } = dlxCommand(ctx.pm, `vinext@${VINEXT_VERSION}`, [
      "init",
      "--platform=cloudflare",
      ...NEXT_CACHE_FLAGS[ctx.options.nextCache],
      "--image-optimization=cloudflare-images",
    ]);
    const result = await runOrThrow(ctx.run, cmd, args, { cwd: ctx.dir, onLine: ctx.log, env });
    warnings.push(...(await updateVinextPeers(ctx, env)));
    if (result.output.includes("approve-builds")) {
      warnings.push(
        "pnpm blocked some dependency build scripts during install. If the Cloudflare build fails, run `pnpm approve-builds` in the project and commit the result.",
      );
    }
    return { baseEntrypoint: "vinext/server/fetch-handler", warnings };
  },
};
