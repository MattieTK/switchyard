import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLOUDFLARE_BUILD_SCRIPT } from "../codegen/build-script.ts";
import { addGitignoreEntries } from "../codegen/gitignore.ts";
import { CF_VERSION, WRANGLER_VERSION } from "../config.ts";
import type { PackageJson } from "../translate/package-json.ts";
import { addCommand, installEnv, type PackageManager, runScriptCommand } from "../translate/package-manager.ts";
import { hasSpaFallback } from "../translate/vercel-json.ts";
import { detectedFrameworks, readPackageJson, runInstall, vercelFunctionWarnings } from "./shared.ts";
import { type Adapter, NO_PROJECT_SETTINGS, type PlanProject, type ProjectSettings } from "./types.ts";

interface StaticPreset {
  name: string;
  // Where Vercel's preset finds the built site, unless the project sets another folder.
  outputDirectory: string;
  // Whether paths without a file serve index.html, as Vercel's preset does for single-page apps.
  spa: boolean;
}

// Vercel framework presets whose build is a folder of static files, which cf can't detect and
// so leaves to Wrangler. Keyed by Vercel's framework slug.
export const STATIC_PRESETS: Readonly<Record<string, StaticPreset>> = {
  "create-react-app": { name: "Create React App", outputDirectory: "build", spa: true },
  gatsby: { name: "Gatsby", outputDirectory: "public", spa: false },
  "docusaurus-2": { name: "Docusaurus", outputDirectory: "build", spa: false },
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

const OTHER: StaticPreset = { name: "Static site", outputDirectory: "public", spa: false };

// Where the built site is: the folder set on Vercel, else the preset's. With no framework, Vercel
// serves public/ when there is one and the repository folder itself otherwise.
export function staticOutputDirectory(settings: ProjectSettings, projectFiles: readonly string[]): string {
  const preset = settings.framework ? STATIC_PRESETS[settings.framework] : undefined;
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

export function staticWranglerConfig(assetsDirectory: string): string {
  return `import { defineWranglerConfig } from "wrangler/experimental-config";

// The folder of built files that Workers serves as static assets.
export default defineWranglerConfig({
  assetsDirectory: ${JSON.stringify(assetsDirectory)},
});
`;
}

// Runs the site's build and then cf build. A build command that changes folder runs in a
// subshell, so cf build still runs in the project's folder.
export function staticBuildScript(build: string): string {
  return /(^|[\s;&|(])cd\s/.test(build) ? `(${build}) && cf build` : `${build} && cf build`;
}

export const staticAdapter: Adapter = {
  id: "static",
  label: "Static site",
  support: { level: "supported" },
  serverRuntime: false,
  requiresPackageJson: false,
  followsBuildSettings: true,
  prSummary:
    "Set the site up to be served as static assets on Cloudflare Workers (`cloudflare.config.ts`, `wrangler.config.ts` and a build script in `package.json`).",
  reservedBindings: ["ASSETS"],
  matches: (input) =>
    (input.vercelFramework === null || Object.hasOwn(STATIC_PRESETS, input.vercelFramework)) &&
    !detectedFrameworks(input.packageJson).length,
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
    const folder = staticOutputDirectory(settings, projectFiles);
    const spa = (settings.framework ? STATIC_PRESETS[settings.framework]?.spa : false) || hasSpaFallback(files["vercel.json"] ?? null);
    const build = staticBuildCommand(settings, packageJson, "npm");
    warnings.push(
      `Switchyard will serve ${folder}/ as static assets${build ? `, after building the site as Vercel did` : ", as it is in the repository"}. ${spa ? "Paths without a file serve index.html, as a single-page app expects." : "Paths without a file serve the nearest 404.html."}`,
    );
    return warnings;
  },
  planBlockers(_packageJson, project: PlanProject) {
    if (staticOutputDirectory(project.settings, project.projectFiles) !== ".") return [];
    return [
      "Vercel serves this site from the repository folder itself, and Switchyard can only deploy a static site from a folder of its own. Move the site's files into a public/ folder, or set an Output Directory in the Vercel project's settings, then build the plan again.",
    ];
  },
  async convert(ctx) {
    const settings = ctx.settings ?? NO_PROJECT_SETTINGS;
    const warnings: string[] = [];
    const manifestPath = join(ctx.dir, "package.json");
    let packageJson = await readPackageJson(ctx.dir);
    if (!packageJson) {
      // cf and Wrangler install from package.json, so a site without one gets a minimal one.
      await writeFile(manifestPath, `${JSON.stringify({ name: ctx.workerName ?? "site", private: true }, null, 2)}\n`);
      packageJson = {};
      warnings.push("The site had no package.json, so Switchyard added one that lists Cloudflare's build tools.");
    }
    const add = addCommand(ctx.pm, [`cf@${CF_VERSION}`, `wrangler@${WRANGLER_VERSION}`], { dev: true });
    await runInstall(ctx, add, installEnv(ctx.pm), warnings, "the install");

    const listing = await readFile(join(ctx.dir, ".gitignore"), "utf8").catch(() => "");
    await writeFile(join(ctx.dir, ".gitignore"), addGitignoreEntries(listing, [".wrangler/"]));
    const folder = staticOutputDirectory(settings, await readdir(ctx.dir));
    if (folder === ".") throw new Error("The site is served from its repository folder, which Switchyard can't deploy. Build the plan again.");
    const vercelJson = await readFile(join(ctx.dir, "vercel.json"), "utf8").catch(() => null);
    const spa = (settings.framework ? STATIC_PRESETS[settings.framework]?.spa : false) || hasSpaFallback(vercelJson);
    await writeFile(
      join(ctx.dir, "cloudflare.config.ts"),
      staticCloudflareConfig({ workerName: ctx.workerName ?? "site", spa, compatibilityDate: today() }),
    );
    await writeFile(join(ctx.dir, "wrangler.config.ts"), staticWranglerConfig(folder));

    const build = staticBuildCommand(settings, packageJson, ctx.pm);
    if (!build) return { warnings };
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { scripts?: Record<string, string> };
    const script = staticBuildScript(build);
    manifest.scripts = { ...manifest.scripts, [CLOUDFLARE_BUILD_SCRIPT]: script };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    warnings.push(
      `Switchyard added a ${CLOUDFLARE_BUILD_SCRIPT} script (\`${script}\`) that builds the site as Vercel did and then packages ${folder}/ for Cloudflare. Workers Builds runs that script.`,
    );
    return { warnings, buildScript: CLOUDFLARE_BUILD_SCRIPT };
  },
};
