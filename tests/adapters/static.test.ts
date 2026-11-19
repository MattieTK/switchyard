import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STAGE_DIR,
  STAGE_SCRIPT,
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
    expect(staticOutputDirectory(settings({ framework: "vitepress" }), [])).toBe(".vitepress/dist");
    expect(staticOutputDirectory(settings({ framework: "vite" }), [])).toBe("dist");
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

  it("packages the assets folder with cf deploy --dry-run and keeps cd in a subshell", () => {
    expect(staticBuildScript("npm run build", "build")).toBe("npm run build && cf deploy build --dry-run");
    expect(staticBuildScript("cd ../.. && turbo run build --filter=web", "dist")).toBe(
      "(cd ../.. && turbo run build --filter=web) && cf deploy dist --dry-run",
    );
    expect(staticBuildScript(null, "public")).toBe("cf deploy public --dry-run");
    expect(staticBuildScript(null, STAGE_DIR, { stage: true })).toBe(
      `node ${STAGE_SCRIPT} && cf deploy ${STAGE_DIR} --dry-run`,
    );
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

  it("matches static presets (even with Vite), Vite < 6 SPAs, and framework-less sites", () => {
    expect(staticAdapter.matches({ vercelFramework: "create-react-app", packageJson: null })).toBe(true);
    expect(staticAdapter.matches({ vercelFramework: "storybook", packageJson: { devDependencies: { vite: "7" } } })).toBe(true);
    expect(staticAdapter.matches({ vercelFramework: "vitepress", packageJson: { devDependencies: { vitepress: "1", vite: "6" } } })).toBe(true);
    expect(staticAdapter.matches({ vercelFramework: "vite", packageJson: { devDependencies: { vite: "^5.4.0" } } })).toBe(true);
    expect(staticAdapter.matches({ vercelFramework: "vite", packageJson: { devDependencies: { vite: "^6.0.0" } } })).toBe(false);
    expect(staticAdapter.matches({ vercelFramework: null, packageJson: { devDependencies: { vite: "^5.4.0" } } })).toBe(true);
    expect(staticAdapter.matches({ vercelFramework: null, packageJson: null })).toBe(true);
    expect(staticAdapter.matches({ vercelFramework: "sveltekit", packageJson: null })).toBe(false);
  });

  it("sets up a Create React App site with cf only (no Wrangler) and single-page fallback", async () => {
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
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([["npm", "install", "-D", "cf@1.0.0-rc.1"]]);
    expect(result.buildScript).toBe("build:cloudflare");
    expect(result.deployDirectory).toBe("build");
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["build:cloudflare"]).toBe("npm run build && cf deploy build --dry-run");
    expect(existsSync(join(dir, "wrangler.config.ts"))).toBe(false);
    const config = await readFile(join(dir, "cloudflare.config.ts"), "utf8");
    expect(config).toContain('name: "shop"');
    expect(config).toContain('"single-page-application"');
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("build/");
  });

  it("serves a plain site's public folder with cf only, and gives it a package.json", async () => {
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
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([["pnpm", "add", "-D", "cf@1.0.0-rc.1"]]);
    expect(result.buildScript).toBe("build:cloudflare");
    expect(result.deployDirectory).toBe("public");
    expect(result.warnings).toContainEqual(expect.stringContaining("had no package.json"));
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8"))).toEqual({
      name: "site",
      private: true,
      scripts: { "build:cloudflare": "cf deploy public --dry-run" },
    });
    expect(await readFile(join(dir, "cloudflare.config.ts"), "utf8")).toContain('"404-page"');
  });

  it("stages sites served from the repository root into .switchyard-assets", async () => {
    await writeFile(join(dir, "index.html"), "<h1>root</h1>");
    const { run } = fakeRunner();
    const result = await staticAdapter.convert({
      dir,
      workerName: "root-site",
      settings: settings(),
      pm: "npm",
      run,
      log: () => {},
      options: { nextCache: "kv" },
    });
    expect(result.deployDirectory).toBe(STAGE_DIR);
    expect(existsSync(join(dir, STAGE_SCRIPT))).toBe(true);
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["build:cloudflare"]).toBe(`node ${STAGE_SCRIPT} && cf deploy ${STAGE_DIR} --dry-run`);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(`${STAGE_DIR}/`);
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

  it("says in the plan how it serves a built folder, a repo-root site, and a Vite 5 SPA", () => {
    const [summary] = staticAdapter.planWarnings?.(
      { scripts: { build: "gatsby build" } },
      {},
      { settings: settings({ framework: "gatsby" }), projectFiles: ["package.json"] },
    ) ?? [];
    expect(summary).toBe(
      "Switchyard will serve public/ as static assets, after building the site as Vercel did. Paths without a file serve the nearest 404.html.",
    );
    const [rootWarning] = staticAdapter.planWarnings?.(null, {}, { settings: settings(), projectFiles: ["index.html"] }) ?? [];
    expect(rootWarning).toContain(STAGE_SCRIPT);
    const vite5Warnings = staticAdapter.planWarnings?.(
      { devDependencies: { vite: "^5.4.0" }, scripts: { build: "vite build" } },
      {},
      { settings: settings({ framework: "vite" }), projectFiles: ["package.json"] },
    );
    expect(vite5Warnings?.[0]).toContain("Vite 5");
  });
});
