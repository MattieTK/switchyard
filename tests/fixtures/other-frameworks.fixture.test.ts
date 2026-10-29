import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { viteAdapter } from "../../src/adapters/cf-init.ts";
import { staticAdapter } from "../../src/adapters/static.ts";
import type { Adapter, ProjectSettings } from "../../src/adapters/types.ts";
import { editCloudflareConfig } from "../../src/codegen/config-edit.ts";
import { createCommandRunner, runOrThrow } from "../../src/exec.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const APPS = join(import.meta.dirname, "apps");

// Converts a fixture app with the adapter, applies Switchyard's config edit and builds the way
// Workers Builds will, with the build:cloudflare script when the adapter wrote one.
async function convertAndBuild(app: string, adapter: Adapter, settings: ProjectSettings) {
  const dir = await makeTempDir();
  await cp(join(APPS, app), dir, { recursive: true });
  const run = createCommandRunner();
  const lines: string[] = [];
  await runOrThrow(run, "git", ["init", "-q"], { cwd: dir });
  const result = await adapter.convert({
    dir,
    workerName: "fixture-app",
    settings,
    pm: "npm",
    run,
    log: (l) => lines.push(l),
    options: { nextCache: "kv" },
  });
  const configPath = join(dir, "cloudflare.config.ts");
  await writeFile(
    configPath,
    editCloudflareConfig(await readFile(configPath, "utf8"), { workerName: "fixture-app", secretKeys: [], crons: [] }),
  );
  const build = result.buildScript
    ? await run("npm", ["run", result.buildScript], { cwd: dir, env: { CI: "1" } })
    : await run("npx", ["--no-install", "cf", "build"], { cwd: dir, env: { CI: "1" } });
  expect(build.code, `${lines.join("\n")}\n${build.output}`).toBe(0);
  const worker = JSON.parse(await readFile(join(dir, ".cloudflare/output/v0/workers/default/worker.config.json"), "utf8")) as {
    name: string;
    assets?: { notFoundHandling?: string };
  };
  const assets = join(dir, ".cloudflare/output/v0/workers/default/assets");
  return { result, worker, assets, build };
}

describe("Vite fixture", () => {
  it("sets up with cf init, keeps the prebuild step and builds a single-page app", async () => {
    const { result, worker, assets, build } = await convertAndBuild("vite-basic", viteAdapter, {
      framework: "vite",
      buildCommand: null,
      outputDirectory: null,
    });
    expect(result.buildScript).toBe("build:cloudflare");
    expect(build.output).toContain("prebuild ran");
    expect(worker.name).toBe("fixture-app");
    expect(worker.assets?.notFoundHandling).toBe("single-page-application");
    expect(await readFile(join(assets, "index.html"), "utf8")).toContain("/assets/");
  });
});

describe("static site fixture", () => {
  it("builds the site as Vercel did and serves its output folder", async () => {
    const { worker, assets } = await convertAndBuild("static-basic", staticAdapter, {
      framework: null,
      buildCommand: null,
      outputDirectory: "build",
    });
    expect(worker.name).toBe("fixture-app");
    expect(worker.assets?.notFoundHandling).toBe("404-page");
    expect(await readFile(join(assets, "index.html"), "utf8")).toContain("Hello from a static site");
  });
});
