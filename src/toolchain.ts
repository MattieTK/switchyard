import { mkdir } from "node:fs/promises";
import type { CommandRunner } from "./exec.ts";
import type { PackageManager } from "./translate/package-manager.ts";

// Package managers corepack can provide, with the fallback install advice for each.
const COREPACK_MANAGERS: Partial<Record<PackageManager, string>> = {
  yarn: "Install it with `npm install -g yarn`, then retry.",
  pnpm: "Install it with `npm install -g pnpm`, then retry.",
};

async function versionOf(run: CommandRunner, pm: PackageManager, cwd: string): Promise<string | null> {
  try {
    const result = await run(pm, ["--version"], { cwd });
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    // The command couldn't be started at all.
    return null;
  }
}

// Makes sure the project's package manager can run. A missing yarn or pnpm is set up
// through corepack in binDir, which the command runner puts first on PATH, so the
// user's global setup is never changed.
export async function ensurePackageManager(input: {
  pm: PackageManager;
  cwd: string;
  run: CommandRunner;
  binDir: string;
  log: (line: string) => void;
}): Promise<void> {
  const { pm, cwd, run, binDir, log } = input;
  // npm comes with Node.
  if (pm === "npm") return;
  if ((await versionOf(run, pm, cwd)) !== null) return;

  const advice = COREPACK_MANAGERS[pm];
  if (!advice) {
    throw new Error(`This project uses ${pm}, which isn't installed on this computer. Install it from https://bun.sh, then retry.`);
  }
  await mkdir(binDir, { recursive: true });
  const enabled = await run("corepack", ["enable", "--install-directory", binDir, pm], { cwd }).then(
    (r) => r.code === 0,
    () => false,
  );
  // Run from the project folder, so corepack honours its packageManager field.
  const version = enabled ? await versionOf(run, pm, cwd) : null;
  if (version === null) {
    throw new Error(
      `This project uses ${pm}, which isn't installed on this computer, and Switchyard couldn't set it up through corepack. ${advice}`,
    );
  }
  log(`${pm} isn't installed, so Switchyard set it up through corepack (version ${version}).`);
}
