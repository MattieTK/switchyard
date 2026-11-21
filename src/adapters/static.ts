import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLOUDFLARE_BUILD_SCRIPT } from "../codegen/build-script.ts";
import { addGitignoreEntries } from "../codegen/gitignore.ts";
import { CF_VERSION } from "../config.ts";
import type { PackageJson } from "../translate/package-json.ts";
import { addCommand, installEnv, type PackageManager, runScriptCommand } from "../translate/package-manager.ts";
import { hasSpaFallback } from "../translate/vercel-json.ts";
import { declaredMajor, detectedFrameworks, readPackageJson, runInstall, vercelFunctionWarnings } from "./shared.ts";
import { type Adapter, NO_PROJECT_SETTINGS, type ProjectSettings } from "./types.ts";

interface StaticPreset {
  name: string;
  // Where Vercel's preset finds the built site, unless the project sets another folder.
  outputDirectory: string;
  // Whether paths without a file serve index.html, as Vercel's preset does for single-page apps.
  spa: boolean;
}

// Vercel framework presets whose build is a folder of static files, packaged directly with
// `cf deploy <dir>` without Wrangler or framework auto-detection. Keyed by Vercel's framework slug.
export const STATIC_PRESETS: Readonly<Record<string, StaticPreset>> = {
  "create-react-app": { name: "Create React App", outputDirectory: "build", spa: true },
  gatsby: { name: "Gatsby", outputDirectory: "public", spa: false },
  "docusaurus-2": { name: "Docusaurus", outputDirectory: "build", spa: false },
  vitepress: { name: "VitePress", outputDirectory: ".vitepress/dist", spa: false },
  vuepress: { name: "VuePress", outputDirectory: ".vuepress/dist", spa: false },
  vue: { name: "Vue CLI", outputDirectory: "dist", spa: true },
  preact: { name: "Preact CLI", outputDirectory: "build", spa: true },
  "ionic-react": { name: "Ionic React", outputDirectory: "build", spa: true },
  svelte: { name: "Svelte", outputDirectory: "public", spa: true },
  ember: { name: "Ember", outputDirectory: "dist", spa: true },
  umijs: { name: "UmiJS", outputDirectory: "dist", spa: true },
  eleventy: { name: "Eleventy", outputDirectory: "_site", spa: false },
  hexo: { name: "Hexo", outputDirectory: "public", spa: false },
  gridsome: { name: "Gridsome", outputDirectory: "dist", spa: false },
  storybook: { name: "Storybook", outputDirectory: "storybook-static", spa: false },
  stencil: { name: "Stencil", outputDirectory: "www", spa: false },
  parcel: { name: "Parcel", outputDirectory: "dist", spa: false },
};

// Vite < 6 SPAs fall through from viteAdapter (cf init needs Vite 6+) and are served as static assets.
const VITE_STATIC_PRESET: StaticPreset = { name: "Vite", outputDirectory: "dist", spa: true };

export const STAGE_SCRIPT = "switchyard-stage.mjs";
export const STAGE_DIR = ".switchyard-assets";

// Files and folders in a repo-root static site that must never be uploaded as public assets.
const STAGE_EXCLUDED = [
  ".git",
  ".github",
  ".cloudflare",
  ".wrangler",
  STAGE_DIR,
  "node_modules",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cloudflare.config.ts",
  STAGE_SCRIPT,
  "vercel.json",
  ".gitignore",
  ".npmrc",
  ".yarnrc.yml",
  ".yarn",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".nvmrc",
  ".node-version",
  ".dev.vars",
];

function presetFor(settings: ProjectSettings, packageJson?: PackageJson | null): StaticPreset | undefined {
  if (settings.framework && Object.hasOwn(STATIC_PRESETS, settings.framework)) return STATIC_PRESETS[settings.framework];
  if (settings.framework === "vite") return VITE_STATIC_PRESET;
  if (settings.framework === null && packageJson && "vite" in { ...packageJson.dependencies, ...packageJson.devDependencies }) {
    return VITE_STATIC_PRESET;
  }
  return undefined;
}

// Where the built site is: the folder set on Vercel, else the preset's. With no framework, Vercel
// serves public/ when there is one and the repository folder itself otherwise.
export function staticOutputDirectory(
  settings: ProjectSettings,
  projectFiles: readonly string[],
  packageJson?: PackageJson | null,
): string {
  const preset = presetFor(settings, packageJson);
  const folder = settings.outputDirectory ?? preset?.outputDirectory ?? (projectFiles.includes("public") ? "public" : ".");
  return folder.replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
}

// The command that builds the site, as Vercel ran it: the build command set on the project, else
// the vercel-build or build script. Null when the site is served as it is in the repository.
export function staticBuildCommand(settings: ProjectSettings, packageJson: PackageJson | null, pm: PackageManager): string | null {
  if (settings.buildCommand?.trim()) return settings.buildCommand.trim();
  const script = ["vercel-build", "build"].find((s) => packageJson?.scripts?.[s]);
  if (!script) return null;
  const c = runScriptCommand(pm, script);
  return [c.cmd, ...c.args].join(" ");
}

const today = () => new Date().toISOString().slice(0, 10);

export function staticCloudflareConfig(o: { workerName: string; spa: boolean; compatibilityDate: string }): string {
  return `import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: ${JSON.stringify(o.workerName)},
    compatibilityDate: ${JSON.stringify(o.compatibilityDate)},
    observability: { enabled: true },
    assets: { notFoundHandling: ${JSON.stringify(o.spa ? "single-page-application" : "404-page")} },
  },
});
`;
}

// Stages a repo-root static site into a clean folder so `cf deploy <dir>` never copies
// node_modules, .git, package.json, or Cloudflare config files into the Worker's assets.
export function stageStaticScript(targetDir = STAGE_DIR): string {
  return `// Generated by Switchyard. Copies repo-root static site files into ${targetDir}/ for \`cf deploy\`.
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TARGET = ${JSON.stringify(targetDir)};
const EXCLUDED = new Set(${JSON.stringify(STAGE_EXCLUDED)});
const isSecretEnv = (name) => /^\\.env(\\..+)?$/.test(name) || /^\\.dev\\.vars(\\..+)?$/.test(name);

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
for (const entry of readdirSync(".")) {
  if (EXCLUDED.has(entry) || isSecretEnv(entry)) continue;
  cpSync(entry, join(TARGET, entry), { recursive: true });
}
`;
}

function quoteDir(dir: string): string {
  return /^[a-zA-Z0-9._/-]+$/.test(dir) ? dir : JSON.stringify(dir);
}

// Runs the site's build (if any) and then packages the assets folder into .cloudflare/output
// using `cf deploy <dir> --dry-run`. A build command that changes folder runs in a subshell so
// `cf deploy` still runs in the project's folder.
export function staticBuildScript(build: string | null, assetsDir: string, o: { stage?: boolean } = {}): string {
  const steps: string[] = [];
  if (build) steps.push(/(^|[\s;&|(])cd\s/.test(build) ? `(${build})` : build);
  if (o.stage) steps.push(`node ${STAGE_SCRIPT}`);
  steps.push(`cf deploy ${quoteDir(assetsDir)} --dry-run`);
  return steps.join(" && ");
}

function isLegacyVite(packageJson: PackageJson | null): boolean {
  const major = declaredMajor(packageJson, "vite");
  return major !== null && major < 6;
}

export const staticAdapter: Adapter = {
  id: "static",
  label: "Static site",
  support: { level: "supported" },
  serverRuntime: false,
  requiresPackageJson: false,
  followsBuildSettings: true,
  prSummary:
    "Set the site up to be served as static assets on Cloudflare Workers with `cf` (`cloudflare.config.ts` and a `build:cloudflare` script in `package.json`).",
  reservedBindings: ["ASSETS"],
  matches(input) {
    // Known static presets (including Storybook+Vite, VitePress, CRA+Vitest) always package their
    // built output directory directly with `cf deploy <dir>`, regardless of devDependencies.
    if (input.vercelFramework && Object.hasOwn(STATIC_PRESETS, input.vercelFramework)) return true;
    // Vite < 6 SPAs fall through from viteAdapter (cf init needs Vite 6+) and deploy dist/ directly.
    if (input.vercelFramework === "vite") return isLegacyVite(input.packageJson);
    if (input.vercelFramework !== null) return false;
    const detected = detectedFrameworks(input.packageJson);
    if (!detected.length) return true;
    return detected.length === 1 && detected[0]?.[0] === "vite" && isLegacyVite(input.packageJson);
  },
  supportFor: (input) =>
    input.vercelFramework === null
      ? {
          level: "partial",
          reason:
            "Vercel didn't detect a framework, so Switchyard moves it as a static site. The plan checks the repository first.",
        }
      : { level: "supported" },
  planWarnings(packageJson, files, project) {
    const settings = project?.settings ?? NO_PROJECT_SETTINGS;
    const projectFiles = project?.projectFiles ?? [];
    const warnings = vercelFunctionWarnings(projectFiles);
    const folder = staticOutputDirectory(settings, projectFiles, packageJson);
    const preset = presetFor(settings, packageJson);
    const spa = (preset?.spa ?? false) || hasSpaFallback(files["vercel.json"] ?? null);
    const build = staticBuildCommand(settings, packageJson, "npm");
    if (preset === VITE_STATIC_PRESET && isLegacyVite(packageJson)) {
      const major = declaredMajor(packageJson, "vite");
      warnings.push(
        `This app uses Vite ${major} (the Cloudflare Vite plugin needs Vite 6 or later), so Switchyard will build it as Vercel did and deploy ${folder}/ directly with cf as static assets.`,
      );
    }
    if (folder === ".") {
      warnings.push(
        `Vercel serves this site from the repository folder itself, so Switchyard will add ${STAGE_SCRIPT} to copy the site's files into ${STAGE_DIR}/ (skipping git, node_modules and config files) before deploying with cf. ${spa ? "Paths without a file serve index.html, as a single-page app expects." : "Paths without a file serve the nearest 404.html."}`,
      );
    } else {
      warnings.push(
        `Switchyard will serve ${folder}/ as static assets${build ? `, after building the site as Vercel did` : ", as it is in the repository"}. ${spa ? "Paths without a file serve index.html, as a single-page app expects." : "Paths without a file serve the nearest 404.html."}`,
      );
    }
    return warnings;
  },
  async convert(ctx) {
    const settings = ctx.settings ?? NO_PROJECT_SETTINGS;
    const warnings: string[] = [];
    const manifestPath = join(ctx.dir, "package.json");
    let packageJson = await readPackageJson(ctx.dir);
    if (!packageJson) {
      // cf installs from package.json, so a site without one gets a minimal one.
      await writeFile(manifestPath, `${JSON.stringify({ name: ctx.workerName ?? "site", private: true }, null, 2)}\n`);
      packageJson = {};
      warnings.push("The site had no package.json, so Switchyard added one that lists Cloudflare's build tool (cf).");
    }
    const add = addCommand(ctx.pm, [`cf@${CF_VERSION}`], { dev: true });
    await runInstall(ctx, add, installEnv(ctx.pm), warnings, "the install");

    const folder = staticOutputDirectory(settings, await readdir(ctx.dir), packageJson);
    const stage = folder === ".";
    const assetsDir = stage ? STAGE_DIR : folder;
    if (stage) {
      await writeFile(join(ctx.dir, STAGE_SCRIPT), stageStaticScript(STAGE_DIR));
      warnings.push(
        `The site is served from its repository folder, so Switchyard added ${STAGE_SCRIPT} to copy its files into ${STAGE_DIR}/ (excluding git, node_modules and config files) before cf packages them.`,
      );
    }

    const vercelJson = await readFile(join(ctx.dir, "vercel.json"), "utf8").catch(() => null);
    const preset = presetFor(settings, packageJson);
    const spa = (preset?.spa ?? false) || hasSpaFallback(vercelJson);
    await writeFile(
      join(ctx.dir, "cloudflare.config.ts"),
      staticCloudflareConfig({ workerName: ctx.workerName ?? "site", spa, compatibilityDate: today() }),
    );

    const build = staticBuildCommand(settings, packageJson, ctx.pm);
    const ignoreEntries: string[] = [];
    if (stage) ignoreEntries.push(`${STAGE_DIR}/`);
    else if (build) ignoreEntries.push(`${folder}/`);
    if (ignoreEntries.length) {
      const listing = await readFile(join(ctx.dir, ".gitignore"), "utf8").catch(() => "");
      await writeFile(join(ctx.dir, ".gitignore"), addGitignoreEntries(listing, ignoreEntries));
    }

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { scripts?: Record<string, string> };
    const script = staticBuildScript(build, assetsDir, { stage });
    manifest.scripts = { ...manifest.scripts, [CLOUDFLARE_BUILD_SCRIPT]: script };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    warnings.push(
      `Switchyard added a ${CLOUDFLARE_BUILD_SCRIPT} script (\`${script}\`) that ${build ? "builds the site as Vercel did and " : ""}packages ${assetsDir}/ for Cloudflare with cf. Workers Builds runs that script.`,
    );
    return { warnings, buildScript: CLOUDFLARE_BUILD_SCRIPT, deployDirectory: assetsDir };
  },
};
