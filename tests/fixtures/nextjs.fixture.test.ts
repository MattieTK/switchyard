import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextjsAdapter } from "../../src/adapters/nextjs.ts";
import { editCloudflareConfig } from "../../src/codegen/config-edit.ts";
import { CRON_ENTRY_FILE, cronEntrySource } from "../../src/codegen/cron-entry.ts";
import { createCommandRunner, runOrThrow } from "../../src/exec.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const FIXTURE = join(import.meta.dirname, "apps", "nextjs-basic");

describe("Next.js fixture", () => {
  it("converts with vinext, applies Switchyard's edits and builds with cf", async () => {
    const dir = await makeTempDir();
    await cp(FIXTURE, dir, { recursive: true });
    const run = createCommandRunner();
    const lines: string[] = [];
    await runOrThrow(run, "git", ["init", "-q"], { cwd: dir });

    const result = await nextjsAdapter.convert({
      dir,
      pm: "pnpm",
      run,
      log: (l) => lines.push(l),
      options: { nextCache: "kv" },
    });

    const crons = [{ path: "/api/cron", schedule: "0 * * * *" }];
    await writeFile(join(dir, CRON_ENTRY_FILE), cronEntrySource(result.baseEntrypoint ?? "", crons));
    const configPath = join(dir, "cloudflare.config.ts");
    await writeFile(
      configPath,
      editCloudflareConfig(await readFile(configPath, "utf8"), {
        workerName: "fixture-app",
        secretKeys: ["API_KEY"],
        crons,
        entrypoint: `./${CRON_ENTRY_FILE}`,
      }),
    );

    const build = await run("pnpm", ["exec", "cf", "build"], { cwd: dir, env: { CI: "1" } });
    expect(build.code, `${lines.join("\n")}\n${build.output}`).toBe(0);

    const built = JSON.parse(
      await readFile(join(dir, ".cloudflare/output/v0/workers/default/worker.config.json"), "utf8"),
    ) as { name: string; triggers: unknown[]; env: Record<string, unknown> };
    expect(built.name).toBe("fixture-app");
    expect(built.triggers).toContainEqual({ type: "scheduled", schedule: "0 * * * *" });
    expect(built.env).toHaveProperty("API_KEY");
    expect(built.env).toHaveProperty("VINEXT_KV_CACHE");
  });
});
