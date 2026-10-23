import type { PackageJson } from "./package-json.ts";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";
const MANAGERS: readonly PackageManager[] = ["pnpm", "npm", "yarn", "bun"];

export function detectPackageManager(files: readonly string[], pkg: PackageJson | null): PackageManager {
  const declared = pkg?.packageManager?.split("@")[0];
  if (declared && (MANAGERS as readonly string[]).includes(declared)) return declared as PackageManager;
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  return "npm";
}

// Installs the project's dependencies.
export function installCommand(pm: PackageManager): { cmd: string; args: string[] } {
  return { cmd: pm, args: ["install"] };
}

// Settings for every command that can install packages during a conversion. npm rejects
// vinext's React peer ranges (ERESOLVE) without legacy-peer-deps. pnpm 11 and later stop
// the install when they skip a dependency's build script, which earlier versions only
// warned about; pnpm 11 reads pnpm_config_* rather than npm_config_* variables.
export function installEnv(pm: PackageManager): Record<string, string> {
  switch (pm) {
    case "npm":
      return { npm_config_legacy_peer_deps: "true" };
    case "pnpm":
      return { pnpm_config_strict_dep_builds: "false" };
    default:
      return {};
  }
}

// Adds packages to the project's dependencies.
export function addCommand(pm: PackageManager, packages: readonly string[]): { cmd: string; args: string[] } {
  return { cmd: pm, args: [pm === "npm" ? "install" : "add", ...packages] };
}

// Runs a binary installed in the project's node_modules.
export function execCommand(pm: PackageManager, bin: string, args: readonly string[]): { cmd: string; args: string[] } {
  switch (pm) {
    case "pnpm":
      return { cmd: "pnpm", args: ["exec", bin, ...args] };
    case "yarn":
      return { cmd: "yarn", args: [bin, ...args] };
    case "bun":
      return { cmd: "bunx", args: [bin, ...args] };
    case "npm":
      return { cmd: "npx", args: ["--no-install", bin, ...args] };
  }
}

// Runs one of the project's package.json scripts.
export function runScriptCommand(pm: PackageManager, script: string): { cmd: string; args: string[] } {
  return { cmd: pm, args: ["run", script] };
}

// The same command as a single string, for Workers Builds build and deploy commands.
export function execString(pm: PackageManager, line: string): string {
  const [bin = "", ...args] = line.split(" ");
  const c = execCommand(pm, bin, args);
  return [c.cmd, ...c.args].join(" ");
}

// Runs a package that isn't installed in the project.
export function dlxCommand(pm: PackageManager, pkg: string, args: readonly string[]): { cmd: string; args: string[] } {
  switch (pm) {
    case "pnpm":
      return { cmd: "pnpm", args: ["dlx", pkg, ...args] };
    // Yarn 1 has no dlx. npx works whichever Yarn the project uses, and tools like
    // vinext still pick Yarn for installs from the lockfile.
    case "yarn":
      return { cmd: "npx", args: ["--yes", pkg, ...args] };
    case "bun":
      return { cmd: "bunx", args: [pkg, ...args] };
    case "npm":
      return { cmd: "npx", args: ["--yes", pkg, ...args] };
  }
}

// Lockfiles of the package managers a project can switch to pnpm from.
export const OTHER_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"] as const;
// The ones pnpm import can read, which keeps the resolved versions.
export const IMPORTABLE_LOCKFILES: readonly string[] = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock"];

export type PnpmSwitchOffer =
  | { available: true; hint: string | null; reresolves: boolean }
  | { available: false; reason: string };

// Whether a project can switch to pnpm, given the file names in its own folder and at the
// repository root. Null for projects that already use pnpm.
export function pnpmSwitchOffer(input: {
  pm: PackageManager;
  packageJson: PackageJson | null;
  projectFiles: readonly string[];
  rootFiles: readonly string[];
}): PnpmSwitchOffer | null {
  const { pm, packageJson, projectFiles, rootFiles } = input;
  if (pm === "pnpm") return null;
  if (packageJson?.workspaces?.length) {
    return {
      available: false,
      reason: `This project uses ${pm} workspaces, and Switchyard can't move workspace settings to pnpm yet.`,
    };
  }
  const locks = OTHER_LOCKFILES.filter((f) => projectFiles.includes(f));
  if (!locks.length && OTHER_LOCKFILES.some((f) => rootFiles.includes(f))) {
    return {
      available: false,
      reason: "The lockfile is at the repository root, outside the project folder, so switching would change other projects too.",
    };
  }
  const reresolves = !locks.some((f) => IMPORTABLE_LOCKFILES.includes(f));
  const yarn1 = pm === "yarn" && (!packageJson?.packageManager || packageJson.packageManager.startsWith("yarn@1."));
  const hint =
    locks.length > 1
      ? `This project has more than one lockfile (${locks.join(", ")}), so different tools can install different versions. One pnpm lockfile replaces them.`
      : yarn1
        ? "This project uses Yarn 1, which only gets maintenance fixes. pnpm import keeps the dependency versions in yarn.lock."
        : null;
  return { available: true, hint, reresolves };
}
