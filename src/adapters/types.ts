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

export interface ConvertContext {
  dir: string;
  pm: PackageManager;
  run: CommandRunner;
  log: (line: string) => void;
  options: AdapterOptions;
}

export interface ConvertResult {
  // Module the generated cron entry should wrap.
  baseEntrypoint: string;
  // package.json script that builds for Cloudflare, when cf build alone would skip steps.
  buildScript?: string;
  warnings: string[];
}

export interface DetectInput {
  vercelFramework: string | null;
  packageJson: PackageJson | null;
}

export interface Adapter {
  id: string;
  label: string;
  support: Support;
  // Binding names the converter creates, which env vars must not reuse.
  reservedBindings: readonly string[];
  matches(input: DetectInput): boolean;
  // The framework upgrade convert will run before converting, or null when none is needed.
  upgradeFor?(packageJson: PackageJson | null): { from: string; to: string } | null;
  // Project files planWarnings reads, fetched when the project has them.
  planFiles?: readonly string[];
  // Things the user should know before approving, shown with the plan. files holds the
  // planFiles the project has, by name.
  planWarnings?(packageJson: PackageJson | null, files: Readonly<Record<string, string>>): string[];
  convert(ctx: ConvertContext): Promise<ConvertResult>;
}
