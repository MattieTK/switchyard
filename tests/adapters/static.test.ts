import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  staticAdapter,
  staticBuildCommand,
  staticBuildScript,
  staticCloudflareConfig,
  staticOutputDirectory,
} from "../../src/adapters/static.ts";
import type { ProjectSettings } from "../../src/adapters/types.ts";
import { fakeRunner } from "../helpers/fake-runner.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const settings = (over: Partial<ProjectSettings> = {}): ProjectSettings => ({
  framework: null,
  buildCommand: null,
  outputDirectory: null,
  ...over,
});

describe("static site helpers", () => {
  it("finds the built site where Vercel did", () => {
    expect(staticOutputDirectory(settings({ framework: "create-react-app" }), [])).toBe("build");
    expect(staticOutputDirectory(settings({ framework: "gatsby" }), [])).toBe("public");
    // A folder set on the project wins over the preset's.
    expect(staticOutputDirectory(settings({ framework: "create-react-app", outputDirectory: "./out/" }), [])).toBe("out");
    // Without a framework, Vercel serves public/ when there is one and the folder itself otherwise.
    expect(staticOutputDirectory(settings(), ["public", "package.json"])).toBe("public");
    expect(staticOutputDirectory(settings(), ["index.html"])).toBe(".");
    expect(staticOutputDirectory(settings({ outputDirectory: "." }), ["public"])).toBe(".");
  });

  it("builds as Vercel did", () => {
    expect(staticBuildCommand(settings({ buildCommand: " make site " }), { scripts: { build: "x" } }, "npm")).toBe("make site");
    expect(staticBuildCommand(settings(), { scripts: { build: "x", "vercel-build": "y" } }, "pnpm")).toBe("pnpm run vercel-build");
    expect(staticBuildCommand(settings(), { scripts: { build: "gatsby build" } }, "yarn")).toBe("yarn run build");
    expect(staticBuildCommand(settings(), { scripts: {} }, "npm")).toBeNull();
    expect(staticBuildCommand(settings(), null, "npm")).toBeNull();
  });

  it("keeps cf build in the project's folder after a build that changes folder", () => {
    expect(staticBuildScript("npm run build")).toBe("npm run build && cf build");
    expect(staticBuildScript("cd ../.. && turbo run build --filter=web")).toBe("(cd ../.. && turbo run build --filter=web) && cf build");
  });

  it("writes a config for single-page apps and for sites with 404 pages", () => {
    expect(staticCloudflareConfig({ workerName: "shop", spa: true, compatibilityDate: "2026-10-29" })).toContain(
      'notFoundHandling: "single-page-application"',
    );
    const site = staticCloudflareConfig({ workerName: "docs", spa: false, compatibilityDate: "2026-10-29" });
    expect(site).toContain('name: "docs"');
    expect(site).toContain('compatibilityDate: "2026-10-29"');
    expect(site).toContain('notFoundHandling: "404-page"');
  });
});

describe("staticAdapter", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("matches static presets and projects without a framework, unless cf would find one", () => {
    expect(staticAdapter.matches({ vercelFramework: "create-react-app", packageJson: null })).toBe(true);
    expect(staticAdapter.matches({ vercelFramework: null, packageJson: null })).toBe(true);
    expect(staticAdapter.matches({ vercelFramework: "sveltekit", packageJson: null })).toBe(false);
    expect(staticAdapter.matches({ vercelFramework: "storybook", packageJson: { devDependencies: { vite: "7" } } })).toBe(false);
  });

  it("sets up a Create React App site with its build and single-page fallback", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "shop", scripts: { build: "react-scripts build" } }));
    const { run, calls } = fakeRunner();
    const result = await staticAdapter.convert({
      dir,
      workerName: "shop",
      settings: settings({ framework: "create-react-app" }),
      pm: "npm",
      run,
      log: () => {},
      options: { nextCache: "kv" },
    });
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([["npm", "install", "-D", "cf@1.0.0-beta.25", "wrangler@4.155.0"]]);
    expect(result.buildScript).toBe("build:cloudflare");
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["build:cloudflare"]).toBe("npm run build && cf build");
    expect(await readFile(join(dir, "wrangler.config.ts"), "utf8")).toContain('assetsDirectory: "build"');
    const config = await readFile(join(dir, "cloudflare.config.ts"), "utf8");
    expect(config).toContain('name: "shop"');
    expect(config).toContain('"single-page-application"');
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(".wrangler/");
  });

  it("serves a plain site's public folder as it is, and gives it a package.json", async () => {
    await mkdir(join(dir, "public"));
    await writeFile(join(dir, "public", "index.html"), "<h1>hi</h1>");
    const { run, calls } = fakeRunner();
    const result = await staticAdapter.convert({
      dir,
      workerName: "site",
      settings: settings(),
      pm: "pnpm",
      run,
      log: () => {},
      options: { nextCache: "kv" },
    });
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([["pnpm", "add", "-D", "cf@1.0.0-beta.25", "wrangler@4.155.0"]]);
    expect(result.buildScript).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining("had no package.json")]);
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8"))).toEqual({ name: "site", private: true });
    expect(await readFile(join(dir, "cloudflare.config.ts"), "utf8")).toContain('"404-page"');
  });

  it("treats a site with a catch-all rewrite in vercel.json as a single-page app", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "parcel build" } }));
    await writeFile(join(dir, "vercel.json"), JSON.stringify({ rewrites: [{ source: "/(.*)", destination: "/index.html" }] }));
    const { run } = fakeRunner();
    await staticAdapter.convert({
      dir,
      settings: settings({ framework: "parcel" }),
      pm: "npm",
      run,
      log: () => {},
      options: { nextCache: "kv" },
    });
    expect(await readFile(join(dir, "cloudflare.config.ts"), "utf8")).toContain('"single-page-application"');
  });

  it("blocks sites served from the repository folder itself", () => {
    expect(staticAdapter.planBlockers?.(null, { settings: settings(), projectFiles: ["index.html"] })).toEqual([
      expect.stringContaining("Move the site's files into a public/ folder"),
    ]);
    expect(staticAdapter.planBlockers?.(null, { settings: settings(), projectFiles: ["public"] })).toEqual([]);
  });

  it("says in the plan which folder it serves and how", () => {
    const [summary] = staticAdapter.planWarnings?.(
      { scripts: { build: "gatsby build" } },
      {},
      { settings: settings({ framework: "gatsby" }), projectFiles: ["package.json"] },
    ) ?? [];
    expect(summary).toBe(
      "Switchyard will serve public/ as static assets, after building the site as Vercel did. Paths without a file serve the nearest 404.html.",
    );
  });
});
