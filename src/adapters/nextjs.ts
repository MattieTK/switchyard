import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VINEXT_VERSION } from "../config.ts";
import { runOrThrow } from "../exec.ts";
import { allDependencies } from "../translate/package-json.ts";
import { dlxCommand } from "../translate/package-manager.ts";
import type { Adapter, NextCachePreset } from "./types.ts";

// vinext refuses to prompt when it detects an agent environment, so every
// choice is passed explicitly. "kv" is the closest match to Vercel's ISR data cache.
export const NEXT_CACHE_FLAGS: Record<NextCachePreset, readonly string[]> = {
  kv: ["--cdn-cache=data-cache", "--data-cache=kv"],
  none: ["--cdn-cache=none", "--data-cache=none"],
};

const LEGACY_PEER_DEPS_SETTING = /^\s*legacy[-_]peer[-_]deps\s*(=|$)/m;

const LEGACY_PEER_DEPS_WARNING =
  "Switchyard added legacy-peer-deps=true to .npmrc because vinext's dependencies ask for a newer React than this project pins. Check the app still works, or update React and remove the setting.";

// vinext init installs a vinext release whose React peer range can be newer than
// the project's pin, which npm rejects with ERESOLVE. Returns true when the line was added.
async function ensureLegacyPeerDeps(dir: string): Promise<boolean> {
  const path = join(dir, ".npmrc");
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing === null) {
    await writeFile(path, "legacy-peer-deps=true\n");
    return true;
  }
  if (LEGACY_PEER_DEPS_SETTING.test(existing)) return false;
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await appendFile(path, `${separator}legacy-peer-deps=true\n`);
  return true;
}

export const nextjsAdapter: Adapter = {
  id: "nextjs",
  label: "Next.js (vinext)",
  support: { level: "supported" },
  reservedBindings: ["ASSETS", "IMAGES", "VINEXT_KV_CACHE"],
  matches: (input) => input.vercelFramework === "nextjs" || "next" in allDependencies(input.packageJson),
  async convert(ctx) {
    const warnings: string[] = [];
    const isNpm = ctx.pm === "npm";
    if (isNpm && (await ensureLegacyPeerDeps(ctx.dir))) warnings.push(LEGACY_PEER_DEPS_WARNING);
    const { cmd, args } = dlxCommand(ctx.pm, `vinext@${VINEXT_VERSION}`, [
      "init",
      "--platform=cloudflare",
      ...NEXT_CACHE_FLAGS[ctx.options.nextCache],
      "--image-optimization=cloudflare-images",
    ]);
    const result = await runOrThrow(ctx.run, cmd, args, {
      cwd: ctx.dir,
      onLine: ctx.log,
      ...(isNpm ? { env: { npm_config_legacy_peer_deps: "true" } } : {}),
    });
    if (result.output.includes("approve-builds")) {
      warnings.push(
        "pnpm blocked some dependency build scripts during install. If the Cloudflare build fails, run `pnpm approve-builds` in the project and commit the result.",
      );
    }
    return { baseEntrypoint: "vinext/server/fetch-handler", warnings };
  },
};
