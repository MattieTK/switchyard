import type { CommandRunner } from "../exec.ts";
import type { PackageJson } from "../translate/package-json.ts";
import type { PackageManager } from "../translate/package-manager.ts";

export type SupportLevel = "supported" | "partial" | "unsupported";

export interface Support {
  level: SupportLevel;
  reason?: string;
}

export type NextCachePreset = "kv" | "none";

export interface AdapterOptions {
  nextCache: NextCachePreset;
  // Opt-ins for apps the adapter upgrades, all off unless the user chose them.
  adoptionCodemods?: boolean;
  eslintMigration?: boolean;
  updateFlaggedPackages?: boolean;
}

// Build settings from the Vercel project. Null where the project uses its framework preset's default.
export interface ProjectSettings {
  // Vercel's framework preset, such as "vite" or "create-react-app", or null for Other.
  framework: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
}

export const NO_PROJECT_SETTINGS: ProjectSettings = { framework: null, buildCommand: null, outputDirectory: null };

export interface ConvertContext {
  dir: string;
  // The Worker's name and the Vercel build settings, for converters that write the config themselves.
  workerName?: string;
  settings?: ProjectSettings;
  pm: PackageManager;
  run: CommandRunner;
  log: (line: string) => void;
  options: AdapterOptions;
}

export interface ConvertResult {
  // Module the generated cron entry should wrap. Absent when the Worker serves static assets only.
  baseEntrypoint?: string;
  // package.json script that builds for Cloudflare, when cf build alone would skip steps.
  buildScript?: string;
  // Compatibility flags the Worker needs, which the convert step adds to cloudflare.config.ts.
  compatibilityFlags?: readonly string[];
  warnings: string[];
}

export interface DetectInput {
  vercelFramework: string | null;
  packageJson: PackageJson | null;
}

// What plan-time checks know about the project beyond its package.json.
export interface PlanProject {
  settings: ProjectSettings;
  // File and folder names in the project's own folder.
  projectFiles: readonly string[];
}

export interface Adapter {
  id: string;
  label: string;
  support: Support;
  // Whether the Worker runs the app's own server code. Without it, runtime secrets and cron
  // routes have nothing to run on, so only build variables are moved.
  serverRuntime: boolean;
  // The "What changed" line of the pull request describing the conversion.
  prSummary: string;
  // False when the project can do without a package.json, which the converter then creates.
  requiresPackageJson?: boolean;
  // Whether convert builds with the project's Vercel build command and output folder.
  followsBuildSettings?: boolean;
  // Binding names the converter creates, which env vars must not reuse.
  reservedBindings: readonly string[];
  matches(input: DetectInput): boolean;
  // Support for a matching project, when it depends on more than the adapter.
  supportFor?(input: DetectInput): Support;
  // The framework upgrade convert will run before converting, or null when none is needed.
  upgradeFor?(packageJson: PackageJson | null): { from: string; to: string } | null;
  // Project files planWarnings reads, fetched when the project has them.
  planFiles?: readonly string[];
  // Things the user should know before approving, shown with the plan. files holds the
  // planFiles the project has, by name.
  planWarnings?(packageJson: PackageJson | null, files: Readonly<Record<string, string>>, project?: PlanProject): string[];
  // Reasons the project can't be converted, shown with the plan, which then can't be approved.
  planBlockers?(packageJson: PackageJson | null, project: PlanProject): string[];
  convert(ctx: ConvertContext): Promise<ConvertResult>;
}
