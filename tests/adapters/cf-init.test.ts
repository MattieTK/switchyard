import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reactRouterAdapter, viteAdapter } from "../../src/adapters/cf-init.ts";
import { fakeRunner } from "../helpers/fake-runner.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const VITE_CONFIG = `import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    "name": "app",
    "compatibilityDate": "2026-10-23",
    "assets": {
      "notFoundHandling": "single-page-application"
    }
  }
});
`;

const QUARANTINED = '➤ YN0016: │ cf@npm:1.0.0-beta.25: All versions satisfying "1.0.0-beta.25" are quarantined';

const RR_CONFIG = VITE_CONFIG.replace('"assets": {\n      "notFoundHandling": "single-page-application"\n    }', '"entrypoint": "./workers/app.ts"');

describe("cf init adapters", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // A runner where cf init writes the given config, as the real one does.
  const initWrites = (config: string) =>
    fakeRunner(async (_cmd, args) => {
      if (args.includes("init")) await writeFile(join(dir, "cloudflare.config.ts"), config);
      return { code: 0, output: "" };
    });

  it("installs dependencies, then runs a pinned cf init without prompts", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
    const { run, calls } = initWrites(VITE_CONFIG);
    const result = await viteAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["pnpm", "install"],
      ["pnpm", "dlx", "cf@1.0.0-beta.25", "init", "."],
    ]);
    expect(calls[1]?.opts?.env).toMatchObject({ CI: "1" });
    // An assets-only Worker has no entry for crons, and vite build alone needs no script.
    expect(result).toEqual({ warnings: [] });
  });

  it("keeps the steps the build script runs before vite build", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc -b && vite build" } }));
    const { run } = initWrites(VITE_CONFIG);
    const result = await viteAdapter.convert({ dir, pm: "npm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(result.buildScript).toBe("build:cloudflare");
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["build:cloudflare"]).toBe("tsc -b && cf build");
  });

  it("fails clearly when cf init writes no config", async () => {
    const { run } = fakeRunner();
    await expect(viteAdapter.convert({ dir, pm: "npm", run, log: () => {}, options: { nextCache: "kv" } })).rejects.toThrow(
      "cf init didn't create cloudflare.config.ts",
    );
  });

  it("runs cf init again from the files it found when Yarn holds a package back", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "vite.config.ts"), "original");
    await writeFile(join(dir, ".yarnrc.yml"), "npmMinimalAgeGate: 3d\n");
    let inits = 0;
    const { run } = fakeRunner(async (_cmd, args) => {
      if (!args.includes("init")) return { code: 0, output: "" };
      inits++;
      // cf init leaves a project that has cloudflare.config.ts alone, so it must be gone on the retry.
      const configured = await readFile(join(dir, "cloudflare.config.ts"), "utf8").then(
        () => true,
        () => false,
      );
      expect(configured).toBe(false);
      expect(await readFile(join(dir, "vite.config.ts"), "utf8")).toBe("original");
      await writeFile(join(dir, "cloudflare.config.ts"), VITE_CONFIG);
      await writeFile(join(dir, "vite.config.ts"), "edited");
      return inits === 1
        ? { code: 1, output: QUARANTINED }
        : { code: 0, output: "" };
    });
    const result = await viteAdapter.convert({ dir, pm: "yarn", run, log: () => {}, options: { nextCache: "kv" } });
    expect(inits).toBe(2);
    expect(await readFile(join(dir, ".yarnrc.yml"), "utf8")).toContain("cf");
    expect(result.warnings[0]).toContain("npmPreapprovedPackages");
  });

  it("returns React Router's Worker entry and asks for Node.js compatibility", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "react-router build" } }));
    const { run } = initWrites(RR_CONFIG);
    const result = await reactRouterAdapter.convert({ dir, pm: "npm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(result).toEqual({ warnings: [], baseEntrypoint: "./workers/app.ts", compatibilityFlags: ["nodejs_compat"] });
  });

  it("removes @vercel/react-router's preset", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(
      join(dir, "react-router.config.ts"),
      `import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

export default {
  ssr: true,
  presets: [vercelPreset()],
} satisfies Config;
`,
    );
    const { run } = initWrites(RR_CONFIG);
    const result = await reactRouterAdapter.convert({ dir, pm: "npm", run, log: () => {}, options: { nextCache: "kv" } });
    const config = await readFile(join(dir, "react-router.config.ts"), "utf8");
    expect(config).not.toContain("vercel");
    expect(config).toContain("presets: [],");
    expect(result.warnings).toEqual([expect.stringContaining("removed @vercel/react-router's preset")]);
  });

  it("warns about the preset, Vercel Functions and Routing Middleware in the plan", () => {
    const warnings = reactRouterAdapter.planWarnings?.(
      {},
      { "react-router.config.ts": 'import { vercelPreset } from "@vercel/react-router/vite";' },
      { settings: { framework: "react-router", buildCommand: null, outputDirectory: null }, projectFiles: ["api", "middleware.ts"] },
    );
    expect(warnings).toEqual([
      expect.stringContaining("@vercel/react-router's preset"),
      expect.stringContaining("api/ folder holds Vercel Functions"),
      expect.stringContaining("middleware.ts is Vercel Routing Middleware"),
    ]);
  });

  it("blocks apps where cf would find a second framework", () => {
    const project = { settings: { framework: "vite", buildCommand: null, outputDirectory: null }, projectFiles: [] };
    expect(viteAdapter.planBlockers?.({ devDependencies: { vite: "7" } }, project)).toEqual([]);
    expect(viteAdapter.planBlockers?.({ devDependencies: { vite: "7", hono: "4" } }, project)).toEqual([
      expect.stringContaining("finds Hono as well as Vite"),
    ]);
    expect(reactRouterAdapter.planBlockers?.({ devDependencies: { vite: "7", "@react-router/dev": "7" } }, project)).toEqual([]);
  });

  it("blocks framework versions cf can't set up", () => {
    const project = { settings: { framework: "vite", buildCommand: null, outputDirectory: null }, projectFiles: [] };
    expect(viteAdapter.planBlockers?.({ devDependencies: { vite: "^5.4.0" } }, project)).toEqual([
      "This app uses vite 5, and the Cloudflare build tool (cf) needs vite 6 or later. Upgrade it, then build the plan again.",
    ]);
    expect(viteAdapter.planBlockers?.({ devDependencies: { vite: "latest" } }, project)).toEqual([]);
  });

  it("matches Vite apps only when Vercel names no other framework", () => {
    expect(viteAdapter.matches({ vercelFramework: "vite", packageJson: null })).toBe(true);
    expect(viteAdapter.matches({ vercelFramework: null, packageJson: { devDependencies: { vite: "7" } } })).toBe(true);
    expect(viteAdapter.matches({ vercelFramework: null, packageJson: { devDependencies: { vite: "7", astro: "5" } } })).toBe(false);
    expect(viteAdapter.matches({ vercelFramework: "remix", packageJson: { devDependencies: { vite: "7" } } })).toBe(false);
  });
});

describe("cf init snapshot", () => {
  it("removes files cf init created before running it again", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, ".yarnrc.yml"), "npmMinimalAgeGate: 3d\n");
    let inits = 0;
    const { run } = fakeRunner(async (_cmd, args) => {
      if (!args.includes("init")) return { code: 0, output: "" };
      inits++;
      if (inits === 2) {
        await expect(readFile(join(dir, "workers/app.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
      await mkdir(join(dir, "workers"), { recursive: true });
      await writeFile(join(dir, "workers/app.ts"), "export default {}");
      await writeFile(join(dir, "cloudflare.config.ts"), RR_CONFIG);
      return inits === 1 ? { code: 1, output: QUARANTINED } : { code: 0, output: "" };
    });
    await reactRouterAdapter.convert({ dir, pm: "yarn", run, log: () => {}, options: { nextCache: "kv" } });
    expect(inits).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });
});
