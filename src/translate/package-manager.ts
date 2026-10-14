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
