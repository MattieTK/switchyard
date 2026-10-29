import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FrameworkBuild } from "../codegen/build-script.ts";
import { CF_VERSION } from "../config.ts";
import { allDependencies, type PackageJson } from "../translate/package-json.ts";
import { dlxCommand, installCommand, installEnv } from "../translate/package-manager.ts";
import { declaredMajor, detectedFrameworks, runInstall, vercelFunctionWarnings, writeCloudflareBuildScript } from "./shared.ts";
import type { Adapter, ConvertContext, DetectInput } from "./types.ts";

// Files cf init writes or edits besides package.json and the lockfile, which runInstall restores
// itself. They go back to how they were before cf init runs again, since cf init leaves a
// project that already has cloudflare.config.ts alone.
const CF_INIT_FILES = [
  "cloudflare.config.ts",
  "wrangler.config.ts",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  ".gitignore",
  "tsconfig.json",
  "workers/app.ts",
  "app/entry.server.tsx",
];

async function snapshot(dir: string, files: readonly string[]): Promise<() => Promise<void>> {
  const saved = await Promise.all(files.map(async (f) => [f, await readFile(join(dir, f), "utf8").catch(() => null)] as const));
  return async () => {
    for (const [f, text] of saved) {
      if (text === null) await rm(join(dir, f), { force: true });
      else await writeFile(join(dir, f), text);
    }
  };
}

const ENTRYPOINT = /["']?entrypoint["']?\s*:\s*["']([^"']+)["']/;

interface CfInitAdapterSpec {
  id: string;
  label: string;
  serverRuntime: boolean;
  prSummary: string;
  build: FrameworkBuild;
  compatibilityFlags?: readonly string[];
  // The dependency cf detects the framework by, which is allowed beside it.
  detectedBy: readonly string[];
  // The oldest major version of the framework's package cf sets up.
  minimum?: { package: string; major: number };
  matches(input: DetectInput): boolean;
  planFiles?: readonly string[];
  planWarnings?(packageJson: PackageJson | null, files: Readonly<Record<string, string>>): string[];
  // Edits after cf init. Returns warnings for the pull request.
  afterInit?(ctx: ConvertContext): Promise<string[]>;
}

// An adapter for a framework cf sets up itself with cf init, which detects the framework,
// adds the Cloudflare Vite plugin, and writes cloudflare.config.ts.
function cfInitAdapter(spec: CfInitAdapterSpec): Adapter {
  return {
    id: spec.id,
    label: spec.label,
    support: { level: "supported" },
    serverRuntime: spec.serverRuntime,
    prSummary: spec.prSummary,
    reservedBindings: ["ASSETS"],
    matches: spec.matches,
    ...(spec.planFiles ? { planFiles: spec.planFiles } : {}),
    planWarnings(packageJson, files, project) {
      return [...(spec.planWarnings?.(packageJson, files) ?? []), ...vercelFunctionWarnings(project?.projectFiles ?? [])];
    },
    planBlockers(packageJson) {
      const blockers: string[] = [];
      const major = spec.minimum ? declaredMajor(packageJson, spec.minimum.package) : null;
      if (spec.minimum && major !== null && major < spec.minimum.major) {
        blockers.push(
          `This app uses ${spec.minimum.package} ${major}, and the Cloudflare build tool (cf) needs ${spec.minimum.package} ${spec.minimum.major} or later. Upgrade it, then build the plan again.`,
        );
      }
      const others = detectedFrameworks(packageJson, spec.detectedBy);
      if (others.length) {
        blockers.push(
          `This app depends on ${others.map(([name]) => name).join(", ")}, so the Cloudflare build tool (cf) finds ${others.map(([, f]) => f).join(", ")} as well as ${spec.label} and can't choose between them. Remove the dependencies the app doesn't use, then build the plan again.`,
        );
      }
      return blockers;
    },
    async convert(ctx) {
      const warnings: string[] = [];
      const env = installEnv(ctx.pm);
      // cf init reads the installed framework's version, so dependencies go in first.
      await runInstall(ctx, installCommand(ctx.pm), env, warnings, "the install");
      const restore = await snapshot(ctx.dir, CF_INIT_FILES);
      const init = dlxCommand(ctx.pm, `cf@${CF_VERSION}`, ["init", "."]);
      await runInstall(ctx, init, { ...env, CI: "1" }, warnings, "cf init", restore);
      const config = await readFile(join(ctx.dir, "cloudflare.config.ts"), "utf8").catch(() => null);
      if (config === null) {
        throw new Error("cf init didn't create cloudflare.config.ts. The log shows the framework it detected.");
      }
      warnings.push(...((await spec.afterInit?.(ctx)) ?? []));
      const buildScript = await writeCloudflareBuildScript(ctx, warnings, spec.build);
      const entrypoint = config.match(ENTRYPOINT)?.[1];
      return {
        warnings,
        ...(entrypoint ? { baseEntrypoint: entrypoint } : {}),
        ...(buildScript ? { buildScript } : {}),
        ...(spec.compatibilityFlags ? { compatibilityFlags: spec.compatibilityFlags } : {}),
      };
    },
  };
}

export const viteAdapter = cfInitAdapter({
  id: "vite",
  label: "Vite",
  serverRuntime: false,
  prSummary:
    "Set the app up to build with the Cloudflare Vite plugin and serve as static assets on Cloudflare Workers (`vite.config.ts`, `cloudflare.config.ts` and new scripts in `package.json`). Paths without a file serve `index.html`, as single-page apps expect.",
  build: { command: "vite build", label: "Vite", pattern: /^(.*?)\bvite\s+build\b.*$/ },
  detectedBy: ["vite"],
  minimum: { package: "vite", major: 6 },
  // Vercel names other Vite-based frameworks after themselves, which other adapters handle or refuse.
  matches: (input) =>
    input.vercelFramework === "vite" ||
    (input.vercelFramework === null && "vite" in allDependencies(input.packageJson) && !detectedFrameworks(input.packageJson, ["vite"]).length),
});

const REACT_ROUTER_CONFIGS = ["react-router.config.ts", "react-router.config.js", "react-router.config.mjs"];
// The import of @vercel/react-router's preset, and its call in the presets list.
const VERCEL_PRESET_IMPORT = /^import\s*\{\s*vercelPreset\s*\}\s*from\s*["']@vercel\/react-router\/vite["'];?[ \t]*\r?\n/m;
const VERCEL_PRESET_CALL = /\bvercelPreset\(\s*\)\s*,?\s*/;

// Removes @vercel/react-router's preset, which shapes the build for Vercel's functions.
// Returns the warning for the pull request, or null when the project doesn't use it.
async function removeVercelPreset(dir: string): Promise<string | null> {
  for (const name of REACT_ROUTER_CONFIGS) {
    const path = join(dir, name);
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null || !text.includes("@vercel/react-router")) continue;
    const edited = text.replace(VERCEL_PRESET_IMPORT, "").replace(VERCEL_PRESET_CALL, "");
    if (edited.includes("vercelPreset")) {
      return `${name} uses @vercel/react-router's preset in a way Switchyard couldn't remove. It shapes the build for Vercel, so remove it before merging.`;
    }
    await writeFile(path, edited);
    return `Switchyard removed @vercel/react-router's preset from ${name}, since it shapes the build for Vercel's functions. You can remove @vercel/react-router from package.json too.`;
  }
  return null;
}

export const reactRouterAdapter = cfInitAdapter({
  id: "react-router",
  label: "React Router",
  serverRuntime: true,
  prSummary:
    "Set the app up to run on Cloudflare Workers with the Cloudflare Vite plugin (`vite.config.ts`, `cloudflare.config.ts`, a Worker entry in `workers/app.ts` and new scripts in `package.json`).",
  build: { command: "react-router build", label: "React Router", pattern: /^(.*?)\breact-router\s+build\b.*$/ },
  // Loaders and actions on Vercel read their settings from process.env, which Workers fill in
  // from the Worker's secrets and variables with Node.js compatibility on.
  compatibilityFlags: ["nodejs_compat"],
  detectedBy: ["vite", "@react-router/dev"],
  minimum: { package: "@react-router/dev", major: 7 },
  matches: (input) => input.vercelFramework === "react-router" || "@react-router/dev" in allDependencies(input.packageJson),
  planFiles: REACT_ROUTER_CONFIGS,
  planWarnings(_packageJson, files) {
    return REACT_ROUTER_CONFIGS.some((f) => files[f]?.includes("@vercel/react-router"))
      ? ["The app uses @vercel/react-router's preset, which shapes the build for Vercel. Switchyard will remove it from the React Router config."]
      : [];
  },
  async afterInit(ctx) {
    const warning = await removeVercelPreset(ctx.dir);
    return warning ? [warning] : [];
  },
});
