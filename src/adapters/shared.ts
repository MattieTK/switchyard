import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { CLOUDFLARE_BUILD_SCRIPT, cloudflareBuildScript, type FrameworkBuild } from "../codegen/build-script.ts";
import { preapproveYarnPackages, quarantinedPackages } from "../codegen/toolchain-files.ts";
import { CommandError, type RunResult } from "../exec.ts";
import { allDependencies, type PackageJson, parsePackageJson } from "../translate/package-json.ts";
import { runScriptCommand } from "../translate/package-manager.ts";
import type { ConvertContext } from "./types.ts";

export async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    return parsePackageJson(await readFile(join(dir, "package.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

// The nearest file called name from dir up to the repository root, or null.
export function findUp(dir: string, name: string): string | null {
  for (let folder = dir; ; folder = dirname(folder)) {
    const path = join(folder, name);
    if (existsSync(path)) return path;
    if (existsSync(join(folder, ".git")) || dirname(folder) === folder) return null;
  }
}

// How many times an install runs again after Yarn holds packages back for their age.
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
// yarn.lock go back to how they were, beforeRetry undoes anything else the command
// changed, and the command runs again.
export async function runInstall(
  ctx: ConvertContext,
  command: { cmd: string; args: string[] },
  env: Record<string, string>,
  warnings: string[],
  label: string,
  beforeRetry?: () => Promise<void>,
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
    await beforeRetry?.();
    approved.push(...blocked);
    ctx.log(
      `Yarn held back ${blocked.join(", ")} as too new, so Switchyard added ${blocked.length === 1 ? "it" : "them"} to npmPreapprovedPackages and is running ${label} again.`,
    );
  }
}

// Writes the build:cloudflare script when the app's build runs steps besides the framework's
// own build. Returns the script's name, or null when cf build alone does the same.
export async function writeCloudflareBuildScript(
  ctx: ConvertContext,
  warnings: string[],
  framework?: FrameworkBuild,
): Promise<string | null> {
  const path = join(ctx.dir, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as { scripts?: Record<string, string> };
  const run = (name: string) => {
    const c = runScriptCommand(ctx.pm, name);
    return [c.cmd, ...c.args].join(" ");
  };
  const result = cloudflareBuildScript(manifest.scripts, run, framework);
  warnings.push(...result.warnings);
  if (!result.script) return null;
  manifest.scripts = { ...manifest.scripts, [CLOUDFLARE_BUILD_SCRIPT]: result.script };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  warnings.push(
    `cf build doesn't run the app's build script, so Switchyard added a ${CLOUDFLARE_BUILD_SCRIPT} script (\`${result.script}\`) that keeps its other build steps, and Workers Builds runs that script.`,
  );
  return CLOUDFLARE_BUILD_SCRIPT;
}

// Dependencies that make cf detect a framework and run that framework's build, whatever
// cloudflare.config.ts says. Checked against cf 1.0.0-beta.25, which reads them from package.json.
export const CF_DETECTED_FRAMEWORKS: Readonly<Record<string, string>> = {
  next: "Next.js",
  vite: "Vite",
  "@react-router/dev": "React Router",
  hono: "Hono",
  astro: "Astro",
  nuxt: "Nuxt",
  "@sveltejs/kit": "SvelteKit",
  "@angular/core": "Angular",
  "@builder.io/qwik": "Qwik",
  "@solidjs/start": "Solid Start",
  "@tanstack/react-start": "TanStack Start",
  vike: "Vike",
  waku: "Waku",
  "@analogjs/platform": "Analog",
};

// The cf-detected frameworks among the project's dependencies, leaving out the ones named.
export function detectedFrameworks(packageJson: PackageJson | null, except: readonly string[] = []): [string, string][] {
  const dependencies = allDependencies(packageJson);
  return Object.entries(CF_DETECTED_FRAMEWORKS).filter(([name]) => name in dependencies && !except.includes(name));
}

// The major version of a dependency's declared range, such as 5 for "^5.4.0", or null for
// ranges that don't start with a version, such as dist tags, workspace links and URLs.
export function declaredMajor(packageJson: PackageJson | null, name: string): number | null {
  const match = allDependencies(packageJson)[name]?.match(/^\s*[\^~>=<v\s]*(\d+)\./);
  return match ? Number(match[1]) : null;
}

// Vercel runs files in api/ as Vercel Functions and middleware.ts as Routing Middleware
// next to any framework. Workers run neither, so the plan says so.
export function vercelFunctionWarnings(projectFiles: readonly string[]): string[] {
  const warnings: string[] = [];
  if (projectFiles.includes("api")) {
    warnings.push(
      "The api/ folder holds Vercel Functions, which Switchyard doesn't move yet. They won't run on Cloudflare: move them into the app, or into a Worker of their own, before switching traffic.",
    );
  }
  const middleware = projectFiles.find((f) => /^middleware\.(ts|js|mjs|mts)$/.test(f));
  if (middleware) {
    warnings.push(
      `${middleware} is Vercel Routing Middleware, which Switchyard doesn't move yet. It won't run on Cloudflare, so check what it does before switching traffic.`,
    );
  }
  return warnings;
}
