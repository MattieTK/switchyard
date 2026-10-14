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
  convert(ctx: ConvertContext): Promise<ConvertResult>;
}
