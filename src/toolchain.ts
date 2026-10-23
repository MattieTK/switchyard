import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "./exec.ts";
import { parsePackageJson } from "./translate/package-json.ts";
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

// The version package.json's packageManager field asks for: "1.22.22" from "yarn@1.22.22+sha512.…".
async function declaredVersion(pm: PackageManager, cwd: string): Promise<string | null> {
  const text = await readFile(join(cwd, "package.json"), "utf8").catch(() => null);
  const [name, version] = parsePackageJson(text)?.packageManager?.split("@") ?? [];
  return name === pm && version ? (version.split("+")[0] ?? null) : null;
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
  const installed = await versionOf(run, pm, cwd);
  const wanted = await declaredVersion(pm, cwd);
  const advice = COREPACK_MANAGERS[pm];
  // A different version than packageManager asks for is set up through corepack too,
  // since Yarn 4 and Yarn 1 install the same project differently.
  if (installed !== null && (wanted === null || installed === wanted || !advice)) return;

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
  if (version === null && installed !== null) {
    log(`Warning: this project asks for ${pm} ${wanted}, and Switchyard couldn't set it up through corepack, so it uses the installed ${installed}.`);
    return;
  }
  if (version === null) {
    throw new Error(
      `This project uses ${pm}, which isn't installed on this computer, and Switchyard couldn't set it up through corepack. ${advice}`,
    );
  }
  log(
    installed === null
      ? `${pm} isn't installed, so Switchyard set it up through corepack (version ${version}).`
      : `This project asks for ${pm} ${wanted}, so Switchyard set it up through corepack instead of the installed ${installed} (version ${version}).`,
  );
}
