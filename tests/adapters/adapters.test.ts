import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextjsAdapter } from "../../src/adapters/nextjs.ts";
import { adapterById, pickAdapter, supportForFramework } from "../../src/adapters/registry.ts";
import { fakeRunner } from "../helpers/fake-runner.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const LEGACY_PEERS_WARNING =
  "Switchyard added legacy-peer-deps=true to .npmrc because vinext's dependencies ask for a newer React than this project pins. Check the app still works, or update React and remove the setting.";

describe("nextjsAdapter", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("matches Vercel's framework or a next dependency", () => {
    expect(nextjsAdapter.matches({ vercelFramework: "nextjs", packageJson: null })).toBe(true);
    expect(nextjsAdapter.matches({ vercelFramework: null, packageJson: { dependencies: { next: "16" } } })).toBe(true);
    expect(nextjsAdapter.matches({ vercelFramework: "vite", packageJson: { dependencies: {} } })).toBe(false);
  });

  it("runs a pinned vinext init with every choice passed as a flag", async () => {
    const { run, calls } = fakeRunner();
    const result = await nextjsAdapter.convert({ dir: "/w", pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(calls[0]).toMatchObject({
      cmd: "pnpm",
      args: [
        "dlx",
        "vinext@1.1.0",
        "init",
        "--platform=cloudflare",
        "--cdn-cache=data-cache",
        "--data-cache=kv",
        "--image-optimization=cloudflare-images",
      ],
      opts: { cwd: "/w" },
    });
    expect(result).toEqual({ baseEntrypoint: "vinext/server/fetch-handler", warnings: [] });
  });

  it("uses the no-cache preset when asked", async () => {
    const { run, calls } = fakeRunner();
    await nextjsAdapter.convert({ dir, pm: "npm", run, log: () => {}, options: { nextCache: "none" } });
    expect(calls[0]?.cmd).toBe("npx");
    expect(calls[0]?.args).toContain("--cdn-cache=none");
    expect(calls[0]?.args).toContain("--data-cache=none");
  });

  it("passes no legacy-peer-deps setting and leaves .npmrc alone for pnpm", async () => {
    const { run, calls } = fakeRunner();
    await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(calls[0]?.opts?.env).not.toHaveProperty("npm_config_legacy_peer_deps");
    await expect(readFile(join(dir, ".npmrc"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets pnpm 11 carry on past blocked build scripts, as earlier versions did", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.1.0" } }));
    const { run, calls } = fakeRunner();
    await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(calls.map((c) => [c.args[0], c.opts?.env?.pnpm_config_strict_dep_builds])).toEqual([
      ["install", "false"],
      ["dlx", "false"],
      ["dlx", "false"],
    ]);
  });

  it("creates .npmrc with legacy-peer-deps for npm and passes it to the init run", async () => {
    const { run, calls } = fakeRunner();
    const r = await nextjsAdapter.convert({ dir, pm: "npm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(await readFile(join(dir, ".npmrc"), "utf8")).toBe("legacy-peer-deps=true\n");
    expect(calls[0]?.opts).toMatchObject({ cwd: dir, env: { npm_config_legacy_peer_deps: "true", npm_config_engine_strict: "false" } });
    expect(r.warnings).toEqual([LEGACY_PEERS_WARNING]);
  });

  it("appends legacy-peer-deps to an existing .npmrc and keeps its content", async () => {
    await writeFile(join(dir, ".npmrc"), "registry=https://example.test/");
    const { run } = fakeRunner();
    const r = await nextjsAdapter.convert({ dir, pm: "npm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(await readFile(join(dir, ".npmrc"), "utf8")).toBe("registry=https://example.test/\nlegacy-peer-deps=true\n");
    expect(r.warnings).toEqual([LEGACY_PEERS_WARNING]);
  });

  it("appends without an extra blank line when .npmrc already ends with a newline", async () => {
    await writeFile(join(dir, ".npmrc"), "save-exact=true\n");
    const { run } = fakeRunner();
    await nextjsAdapter.convert({ dir, pm: "npm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(await readFile(join(dir, ".npmrc"), "utf8")).toBe("save-exact=true\nlegacy-peer-deps=true\n");
  });

  it("leaves .npmrc unchanged and adds no warning when legacy-peer-deps is already set", async () => {
    const original = "legacy-peer-deps=false\nsave-exact=true";
    await writeFile(join(dir, ".npmrc"), original);
    const { run } = fakeRunner();
    const r = await nextjsAdapter.convert({ dir, pm: "npm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(await readFile(join(dir, ".npmrc"), "utf8")).toBe(original);
    expect(r.warnings).toEqual([]);
  });

  it("warns in the plan when the app's Next.js is older than 16", () => {
    const [warning, ...rest] = nextjsAdapter.planWarnings?.({ dependencies: { next: "10.0.2" } }, {}) ?? [];
    expect(rest).toEqual([]);
    expect(warning).toBe(
      "This app uses Next.js 10. Switchyard will upgrade it to Next.js 16.4.1 with the official Next.js codemods before converting, because vinext needs Next.js 16. Only the required migrations run unless you choose more under Upgrade options. Upgrading across major versions can change how the app behaves, so review the pull request and test the preview before switching traffic.",
    );
    expect(nextjsAdapter.planWarnings?.({ dependencies: { next: "^16.1.0" } }, {})).toEqual([]);
    expect(nextjsAdapter.planWarnings?.({ dependencies: { next: "canary" } }, {})).toEqual([]);
    expect(nextjsAdapter.planWarnings?.(null, {})).toEqual([]);
    expect(nextjsAdapter.upgradeFor?.({ dependencies: { next: "^13.4.0" } })).toEqual({ from: "^13.4.0", to: "16.4.1" });
    expect(nextjsAdapter.upgradeFor?.({ dependencies: { next: "16.2.0" } })).toBeNull();
  });

  it("warns in the plan about Hono and standalone output, which the Cloudflare build can't handle yet", () => {
    const [frameworks] =
      nextjsAdapter.planWarnings?.({ dependencies: { next: "16.2.0", hono: "^4.9.6" }, devDependencies: { astro: "5" } }, {}) ?? [];
    expect(frameworks).toContain("depends on hono, astro, so the Cloudflare build tool (cf) finds Hono, Astro as well as Next.js and Vite");
    // Packages cf doesn't treat as a framework of their own.
    expect(nextjsAdapter.planWarnings?.({ dependencies: { next: "16.2.0", "react-router": "7", express: "5" } }, {})).toEqual([]);

    const pkg = { dependencies: { next: "16.2.0" } };
    for (const config of [
      'const nextConfig = {\n  output: "standalone",\n};\nexport default nextConfig;\n',
      "module.exports = { output: process.env.E2E_BUILD === 'true' ? undefined : 'standalone' }",
      "const nextConfig = {};\nnextConfig.output = `standalone`;\n",
    ]) {
      const [standalone] = nextjsAdapter.planWarnings?.(pkg, { "next.config.mjs": config }) ?? [];
      expect(standalone).toContain('next.config sets output: "standalone"');
    }
    expect(nextjsAdapter.planWarnings?.(pkg, { "next.config.ts": "output: 'export', basePath: '/standalone'" })).toEqual([]);
  });

  it("installs, upgrades Next.js with the codemods, then runs vinext for an app older than 16", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "10.0.2" } }));
    const { run, calls } = fakeRunner();
    const r = await nextjsAdapter.convert({ dir, pm: "yarn", run, log: () => {}, options: { nextCache: "kv" } });
    expect(calls.map((c) => [c.cmd, ...c.args.slice(0, 5)])).toEqual([
      ["yarn", "install"],
      ["yarn", "--version"],
      ["npx", "--yes", "@next/codemod@16.4.1", "upgrade", "16.4.1", "--yes"],
      ["npx", "--yes", "vinext@1.1.0", "init", "--platform=cloudflare", "--cdn-cache=data-cache"],
    ]);
    expect(calls[0]?.opts?.cwd).toBe(dir);
    // The codemod picks its package manager from the user agent before the lockfile.
    expect(calls[2]?.opts).toMatchObject({ cwd: dir, env: { npm_config_user_agent: "yarn/switchyard" } });
    expect(r.warnings).toEqual([
      "Switchyard upgraded Next.js from 10.0.2 to 16.4.1 with the official Next.js codemods. The codemods don't cover every breaking change, so review the pull request and test the preview before switching traffic.",
    ]);
  });

  it("installs Next.js 11 first for an app older than 11, so the upgrade skips cra-to-next", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ devDependencies: { next: "^10.0.2" } }));
    const declared: string[] = [];
    const { run } = fakeRunner(async (_cmd, args) => {
      if (args[0] === "install") declared.push(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).devDependencies.next);
      return { code: 0, output: "" };
    });
    const r = await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(declared).toEqual(["11.1.4"]);
    expect(r.warnings[0]).toContain("from ^10.0.2 to 16.4.1");
  });

  it("hides Yarn 1's missing dlx from the upgrade, so its React codemods use npx", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "14.2.0" } }));
    let wrapper: string | null = null;
    const { run, calls } = fakeRunner(async (_cmd, args, opts) => {
      if (args[0] === "--version") return { code: 0, output: "1.22.22\n" };
      if (args[0] === "--yes" && args[1]?.startsWith("@next/codemod") && opts?.pathPrefix) {
        wrapper = await readFile(join(opts.pathPrefix, "yarn"), "utf8");
      }
      return { code: 0, output: "" };
    });
    await nextjsAdapter.convert({ dir, pm: "yarn", run, log: () => {}, options: { nextCache: "kv" } });
    expect(calls.map((c) => [c.cmd, c.args[0]])).toEqual([
      ["yarn", "install"],
      ["yarn", "--version"],
      ["npx", "--yes"],
      ["npx", "--yes"],
    ]);
    expect(wrapper).toContain('if [ "$1" = "dlx" ]; then');
    expect(wrapper).toContain('exec yarn "$@"');
    // The wrapper folder is removed afterwards.
    await expect(readFile(join(calls[2]?.opts?.pathPrefix ?? "/missing", "yarn"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves Yarn 2 and later alone, since they have dlx", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "14.2.0" } }));
    const { run, calls } = fakeRunner((_cmd, args) => ({ code: 0, output: args[0] === "--version" ? "4.6.0\n" : "" }));
    await nextjsAdapter.convert({ dir, pm: "yarn", run, log: () => {}, options: { nextCache: "kv" } });
    expect(calls[2]?.opts?.pathPrefix).toBeUndefined();
  });

  it("passes on the packages the upgrade flags as incompatible", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.1.0" } }));
    const flagged = `⚠ Found 1 dependency that seem incompatible with the upgraded package versions.
You may have to update these packages to their latest version or file an issue to ask for support of the upgraded libraries.
old-lib 1.0.0
  └── ✕ unmet peer react@"^18": found 19.3.1
`;
    const { run } = fakeRunner((_cmd, args) => ({ code: 0, output: args[1]?.startsWith("@next/codemod") ? flagged : "" }));
    const r = await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(r.warnings).toEqual([
      expect.stringContaining("Switchyard upgraded Next.js from 15.1.0"),
      "old-lib 1.0.0 supports react ^18, but the upgrade installed react 19.3.1. If the build or the app fails, update or replace it.",
    ]);
  });

  it("runs the npm install and upgrade with legacy-peer-deps", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^14.2.0" } }));
    const { run, calls } = fakeRunner();
    await nextjsAdapter.convert({ dir, pm: "npm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(calls.map((c) => [c.cmd, c.args[0], c.opts?.env?.npm_config_legacy_peer_deps])).toEqual([
      ["npm", "install", "true"],
      ["npx", "--yes", "true"],
      ["npx", "--yes", "true"],
    ]);
  });

  describe("upgrade options", () => {
    const upgradeArgs = (calls: { args: string[] }[]) => calls.find((c) => c.args[1]?.startsWith("@next/codemod"))?.args.slice(2);

    it("runs only the required migrations unless the user chose more", async () => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.1.0" } }));
      const { run, calls } = fakeRunner();
      await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
      expect(upgradeArgs(calls)).toEqual(["upgrade", "16.4.1", "--yes", "--skip-adoption", "--skip-eslint-upgrade"]);
    });

    it("drops the skip flag for each chosen option", async () => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.1.0" } }));
      for (const [options, expected] of [
        [{ adoptionCodemods: true }, ["--skip-eslint-upgrade"]],
        [{ eslintMigration: true }, ["--skip-adoption"]],
        [{ adoptionCodemods: true, eslintMigration: true }, []],
      ] as const) {
        const { run, calls } = fakeRunner();
        await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv", ...options } });
        expect(upgradeArgs(calls)).toEqual(["upgrade", "16.4.1", "--yes", ...expected]);
      }
    });

    it("names the chosen options when the upgrade fails", async () => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.1.0" } }));
      const failing = () =>
        fakeRunner((_cmd, args) => ({ code: args[1]?.startsWith("@next/codemod") ? 1 : 0, output: "Failed to run eslint migrate-config" })).run;
      await expect(
        nextjsAdapter.convert({ dir, pm: "pnpm", run: failing(), log: () => {}, options: { nextCache: "kv", eslintMigration: true } }),
      ).rejects.toThrow("The Next.js upgrade failed with ESLint migration chosen. Check the log, or build the plan again without it.");
      await expect(
        nextjsAdapter.convert({ dir, pm: "pnpm", run: failing(), log: () => {}, options: { nextCache: "kv" } }),
      ).rejects.toThrow("exited with code 1");
    });

    it("updates flagged packages to a latest release that supports the new React, when chosen", async () => {
      const report = `⚠ Found 3 dependencies that seem incompatible with the upgraded package versions.
You may have to update these packages to their latest version or file an issue to ask for support of the upgraded libraries.
framer-motion 7.3.5
  └── ✕ unmet peer react@"^18.0.0": found 19.3.1
recharts 2.1.14
  └── ✕ unmet peer react@"^16.0.0 || ^17.0.0 || ^18.0.0": found 19.3.1
ai 2.2.1
  └── ✕ unmet peer react@"^18.2.0": found 19.3.1
`;
      const registry: Record<string, { code: number; output: string }> = {
        "framer-motion@>7.3.5": {
          code: 0,
          output: '[{"version":"10.18.0","peerDependencies":{"react":"^18.0.0"}},{"version":"11.13.5","peerDependencies":{"react":"^18.0.0 || ^19.0.0"}},"12.0.0"]',
        },
        "recharts@>2.1.14": { code: 0, output: '{"version":"2.15.0","peerDependencies":{"react":"^16.0.0 || ^17.0.0 || ^18.0.0"}}' },
        "ai@>2.2.1": { code: 1, output: "npm error 403 Forbidden" },
      };
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ dependencies: { next: "13.4.0", "framer-motion": "^7.3.5", recharts: "^2.1.14", ai: "2.2.1" } }),
      );
      const options = { nextCache: "kv" as const, updateFlaggedPackages: true };
      const { run, calls } = fakeRunner((cmd, args) => {
        if (cmd === "npm" && args[0] === "view") return registry[args[1] ?? ""] ?? { code: 1, output: "" };
        return { code: 0, output: args[1]?.startsWith("@next/codemod") ? report : "" };
      });
      const r = await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options });
      expect(calls.find((c) => c.args[0] === "add")?.args).toEqual(["add", "framer-motion@^11.13.5"]);
      expect(r.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Switchyard updated framer-motion from 7.3.5 to ^11.13.5, the first release"),
          expect.stringContaining("No newer release declares support for react 19.3.1 either"),
          expect.stringContaining("couldn't look up its releases"),
        ]),
      );

      // Without the option, the report only becomes warnings and nothing is looked up.
      await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "13.4.0", "framer-motion": "^7.3.5" } }));
      const plain = fakeRunner((_cmd, args) => ({ code: 0, output: args[1]?.startsWith("@next/codemod") ? report : "" }));
      const p = await nextjsAdapter.convert({ dir, pm: "pnpm", run: plain.run, log: () => {}, options: { nextCache: "kv" } });
      expect(plain.calls.some((c) => c.cmd === "npm")).toBe(false);
      expect(p.warnings).toContain(
        "framer-motion 7.3.5 supports react ^18.0.0, but the upgrade installed react 19.3.1. If the build or the app fails, update or replace it.",
      );
    });

    it("counts no newer release as nothing to update to", async () => {
      const report = `⚠ Found 1 dependency that seem incompatible with the upgraded package versions.
advice
old-lib 1.0.0
  └── ✕ unmet peer react@"^18.0.0": found 19.3.1
`;
      await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "13.4.0", "old-lib": "1.0.0" } }));
      const { run } = fakeRunner((cmd, args) => {
        if (cmd === "npm" && args[0] === "view") return { code: 1, output: '{"error":{"summary":"No match found for version >1.0.0"}}' };
        return { code: 0, output: args[1]?.startsWith("@next/codemod") ? report : "" };
      });
      const r = await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv", updateFlaggedPackages: true } });
      expect(r.warnings).toContainEqual(expect.stringContaining("No newer release declares support"));
    });

    it("names the option when installing the updates fails", async () => {
      const report = `⚠ Found 1 dependency that seem incompatible with the upgraded package versions.
advice
framer-motion 7.3.5
  └── ✕ unmet peer react@"^18.0.0": found 19.3.1
`;
      await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "13.4.0", "framer-motion": "^7.3.5" } }));
      const { run } = fakeRunner((cmd, args) => {
        if (cmd === "npm" && args[0] === "view") return { code: 0, output: '"12.4.0"' };
        if (cmd === "npm") return { code: 0, output: "" };
        if (args[0] === "add") return { code: 1, output: "ERR_PNPM_FETCH_404" };
        return { code: 0, output: args[1]?.startsWith("@next/codemod") ? report : "" };
      });
      await expect(
        nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv", updateFlaggedPackages: true } }),
      ).rejects.toThrow("Updating framer-motion failed (pnpm add framer-motion@^12.4.0 exited with code 1). Check the log, or build the plan again without Update flagged packages.");
    });

    it("warns about scripts that still run next lint when the ESLint migration didn't run", async () => {
      const pkg = { dependencies: { next: "15.1.0" }, scripts: { lint: "next lint", "lint:fix": "next lint --fix", test: "vitest" } };
      await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
      const r = await nextjsAdapter.convert({ dir, pm: "pnpm", run: fakeRunner().run, log: () => {}, options: { nextCache: "kv" } });
      expect(r.warnings).toContain(
        "The lint, lint:fix scripts run next lint, which Next.js 16 removed. Choose ESLint migration under Upgrade options, or change them to run eslint directly.",
      );
      await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
      const migrated = await nextjsAdapter.convert({
        dir,
        pm: "pnpm",
        run: fakeRunner().run,
        log: () => {},
        options: { nextCache: "kv", eslintMigration: true },
      });
      expect(migrated.warnings.join("\n")).not.toContain("next lint");
    });
  });

  it("doesn't upgrade an app already on Next.js 16", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "16.2.0" } }));
    const { run, calls } = fakeRunner();
    await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(calls.map((c) => c.args[1])).toEqual(["vinext@1.1.0"]);
  });

  describe("vinext's peer dependencies", () => {
    const install = async (folder: string, name: string, manifest: object) => {
      await mkdir(join(folder, "node_modules", name), { recursive: true });
      await writeFile(join(folder, "node_modules", name, "package.json"), JSON.stringify(manifest));
    };
    const PEERS = { react: "^19.3.1", "react-dom": "^19.3.1", "@vitejs/plugin-react": "^5.1.4 || ^6.0.0", "@mdx-js/rollup": "^3.0.0" };
    const convertAfterInit = (pm: "pnpm" | "npm", at = dir) => {
      const { run, calls } = fakeRunner(async (_cmd, args) => {
        // vinext init installs vinext, as the real one does.
        if (args.includes("init")) await install(at, "vinext", { peerDependencies: PEERS });
        return { code: 0, output: "" };
      });
      return { calls, result: nextjsAdapter.convert({ dir, pm, run, log: () => {}, options: { nextCache: "kv" } }) };
    };

    it("updates each installed peer that is outside vinext's range", async () => {
      await install(dir, "react", { version: "19.2.8" });
      await install(dir, "react-dom", { version: "19.2.8" });
      await install(dir, "@vitejs/plugin-react", { version: "5.0.0" });
      const { calls, result } = convertAfterInit("pnpm");
      const r = await result;
      expect(calls.at(-1)).toMatchObject({
        cmd: "pnpm",
        args: ["add", "react@^19.3.1", "react-dom@^19.3.1", "@vitejs/plugin-react@^5.1.4 || ^6.0.0"],
        opts: { cwd: dir, env: { pnpm_config_strict_dep_builds: "false" } },
      });
      expect(r.warnings).toEqual([
        "Switchyard updated react from 19.2.8 to ^19.3.1, because vinext needs a version in that range. Check the app still works with it.",
        "Switchyard updated react-dom from 19.2.8 to ^19.3.1, because vinext needs a version in that range. Check the app still works with it.",
        "Switchyard updated @vitejs/plugin-react from 5.0.0 to ^5.1.4 || ^6.0.0, because vinext needs a version in that range. Check the app still works with it.",
      ]);
    });

    it("leaves peers in range, and peers the app doesn't have, alone", async () => {
      await install(dir, "react", { version: "19.3.1" });
      await install(dir, "react-dom", { version: "19.4.0-canary-abc" });
      await install(dir, "@vitejs/plugin-react", { version: "6.1.2" });
      const { calls, result } = convertAfterInit("pnpm");
      expect((await result).warnings).toEqual([]);
      expect(calls.map((c) => c.args[0])).toEqual(["dlx"]);
    });

    it("finds peers installed at a workspace root", async () => {
      const root = dir;
      dir = join(root, "apps", "web");
      await mkdir(dir, { recursive: true });
      await install(root, "react", { version: "19.1.0" });
      const { calls, result } = convertAfterInit("npm", root);
      await result;
      expect(calls.at(-1)).toMatchObject({
        cmd: "npm",
        args: ["install", "react@^19.3.1"],
        opts: { env: { npm_config_legacy_peer_deps: "true" } },
      });
      dir = root;
    });
  });

  it("adds a build:cloudflare script that keeps the steps before next build", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "16.2.0" }, scripts: { build: "prisma generate && next build" } }),
    );
    const { run } = fakeRunner();
    const r = await nextjsAdapter.convert({ dir, pm: "npm", run, log: () => {}, options: { nextCache: "kv" } });
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(manifest.scripts).toEqual({
      build: "prisma generate && next build",
      "build:cloudflare": "prisma generate && cf build",
    });
    expect(r.buildScript).toBe("build:cloudflare");
    expect(r.warnings).toContain(
      "cf build doesn't run the app's build script, so Switchyard added a build:cloudflare script (`prisma generate && cf build`) that keeps its other build steps, and Workers Builds runs that script.",
    );
  });

  it("adds no script when the build is only next build", async () => {
    const original = `${JSON.stringify({ dependencies: { next: "16.2.0" }, scripts: { build: "next build" } }, null, 2)}\n`;
    await writeFile(join(dir, "package.json"), original);
    const { run } = fakeRunner();
    const r = await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(r.buildScript).toBeUndefined();
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(original);
  });

  describe("Yarn's release-age gate", () => {
    const QUARANTINED = `➤ YN0027: @cloudflare/vite-plugin@beta can't be resolved to a satisfying range
➤ YN0016: All versions satisfying "^2.0.0-beta.v.4" are quarantined`;
    const DEPENDENCY = `➤ YN0016: │ miniflare@npm:5.20261019.1-beta: All versions satisfying "5.20261019.1-beta" are quarantined`;

    // vinext init that changes package.json, then fails with each output in turn until they run out.
    const initFailing = (outputs: string[]) => {
      const seen: string[] = [];
      const { run, calls } = fakeRunner(async (_cmd, args) => {
        if (!args.includes("init")) return { code: 0, output: "" };
        seen.push(await readFile(join(dir, "package.json"), "utf8").catch(() => ""));
        await writeFile(join(dir, "package.json"), '{"type":"module","half":"done"}');
        const output = outputs.shift();
        return output === undefined ? { code: 0, output: "" } : { code: 1, output };
      });
      return { run, calls, seen };
    };

    it("preapproves the packages Yarn held back and runs vinext init again from the same files", async () => {
      await writeFile(join(dir, "package.json"), '{"name":"app"}');
      await writeFile(join(dir, ".yarnrc.yml"), 'npmMinimalAgeGate: "3d"\n');
      const { run, calls, seen } = initFailing([QUARANTINED, DEPENDENCY]);
      const r = await nextjsAdapter.convert({ dir, pm: "yarn", run, log: () => {}, options: { nextCache: "kv" } });
      expect(calls.filter((c) => c.args.includes("init"))).toHaveLength(3);
      expect(seen).toEqual(['{"name":"app"}', '{"name":"app"}', '{"name":"app"}']);
      expect(await readFile(join(dir, ".yarnrc.yml"), "utf8")).toBe(
        'npmMinimalAgeGate: "3d"\n\nnpmPreapprovedPackages:\n  - "miniflare"\n  - "@cloudflare/*"\n',
      );
      expect(r.warnings).toContain(
        "Switchyard added @cloudflare/*, miniflare to npmPreapprovedPackages in .yarnrc.yml, because Yarn held back these releases as newer than npmMinimalAgeGate and the conversion needs them. Remove the entries if you'd rather wait for those releases to age.",
      );
    });

    it("uses the repository root's .yarnrc.yml in a monorepo", async () => {
      const root = dir;
      await mkdir(join(root, ".git"));
      await writeFile(join(root, ".yarnrc.yml"), "nodeLinker: pnp\n");
      dir = join(root, "apps", "web");
      await mkdir(dir, { recursive: true });
      const { run } = initFailing([QUARANTINED]);
      const r = await nextjsAdapter.convert({ dir, pm: "yarn", run, log: () => {}, options: { nextCache: "kv" } });
      expect(await readFile(join(root, ".yarnrc.yml"), "utf8")).toContain('  - "@cloudflare/*"');
      await expect(readFile(join(dir, ".yarnrc.yml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(r.warnings.at(-1)).toContain("in ../../.yarnrc.yml, because");
      dir = root;
    });

    it("approves a scope once, however many of its packages Yarn holds back", async () => {
      const scoped = (name: string) => `➤ YN0016: │ @cloudflare/${name}@npm:1.0.0: All versions satisfying "1.0.0" are quarantined`;
      const { run, calls } = initFailing([QUARANTINED, scoped("config"), scoped("runtime-types")]);
      await expect(nextjsAdapter.convert({ dir, pm: "yarn", run, log: () => {}, options: { nextCache: "kv" } })).rejects.toThrow(
        "exited with code 1",
      );
      // The second failure names nothing new, so there is no third run.
      expect(calls.filter((c) => c.args.includes("init"))).toHaveLength(2);
    });

    it("stops when a retry reports nothing new, and leaves other failures alone", async () => {
      await expect(
        nextjsAdapter.convert({ dir, pm: "yarn", run: initFailing([QUARANTINED, QUARANTINED]).run, log: () => {}, options: { nextCache: "kv" } }),
      ).rejects.toThrow("exited with code 1");
      await rm(join(dir, ".yarnrc.yml"));
      const { run, calls } = initFailing(["ERESOLVE could not resolve"]);
      await expect(nextjsAdapter.convert({ dir, pm: "yarn", run, log: () => {}, options: { nextCache: "kv" } })).rejects.toThrow();
      expect(calls.filter((c) => c.args.includes("init"))).toHaveLength(1);
      await expect(readFile(join(dir, ".yarnrc.yml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("creates the empty-stub.js vinext points native modules at, which vinext init leaves out", async () => {
    const config = `import path from "node:path";
export default defineConfig({
  resolve: {
    alias: {
      "sharp": path.resolve(__dirname, "empty-stub.js"),
      "satori": path.resolve(__dirname, "empty-stub.js"),
    },
  },
});
`;
    const { run } = fakeRunner(async (_cmd, args) => {
      if (args.includes("init")) await writeFile(join(dir, "vite.config.ts"), config);
      return { code: 0, output: "" };
    });
    const r = await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(await readFile(join(dir, "empty-stub.js"), "utf8")).toContain("export default {};");
    expect(r.warnings).toContain(
      "vinext replaces sharp, satori with an empty module (empty-stub.js), because they need Node.js. Code that calls them at runtime won't work on Workers.",
    );
  });

  it("lets the build continue past imports of names a module doesn't export, as webpack did", async () => {
    // What vinext init generates, trimmed.
    const config = `import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import path from "node:path";

export default defineConfig({
  plugins: [vinext(), cloudflare()],
  css: {
    modules: {
      generateScopedName(name: string, filename: string) {
        return path.relative(import.meta.dirname, filename) + name;
      },
    },
  },
});
`;
    const { run } = fakeRunner(async (_cmd, args) => {
      if (args.includes("init")) await writeFile(join(dir, "vite.config.ts"), config);
      return { code: 0, output: "" };
    });
    await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    const edited = await readFile(join(dir, "vite.config.ts"), "utf8");
    expect(edited).toMatch(/build: \{\s*rolldownOptions: \{\s*shimMissingExports: true/);
    expect(edited).toContain("generateScopedName(name: string, filename: string)");

    // A value the project set stays as it is, and a config of another shape is left alone.
    for (const own of [
      "export default defineConfig({ build: { rolldownOptions: { shimMissingExports: false } } });\n",
      "export default defineConfig(({ mode }) => ({ plugins: [] }));\n",
    ]) {
      const { run } = fakeRunner(async (_cmd, args) => {
        if (args.includes("init")) await writeFile(join(dir, "vite.config.ts"), own);
        return { code: 0, output: "" };
      });
      await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
      expect(await readFile(join(dir, "vite.config.ts"), "utf8")).toBe(own);
    }
  });

  it("makes output: standalone apply only outside the Cloudflare build", async () => {
    for (const [file, before, after] of [
      ["next.config.mjs", 'export default { output: "standalone" };\n', 'export default { output: (process.env.CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT ? undefined : "standalone") };\n'],
      [
        "next.config.js",
        "module.exports = { output: process.env.E2E === 'true' ? undefined : 'standalone', images: {} };\n",
        "module.exports = { output: process.env.E2E === 'true' ? undefined : (process.env.CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT ? undefined : 'standalone'), images: {} };\n",
      ],
    ] as const) {
      await rm(join(dir, "next.config.mjs"), { force: true });
      await writeFile(join(dir, file), before);
      const r = await nextjsAdapter.convert({ dir, pm: "pnpm", run: fakeRunner().run, log: () => {}, options: { nextCache: "kv" } });
      expect(await readFile(join(dir, file), "utf8")).toBe(after);
      expect(r.warnings).toContainEqual(expect.stringContaining(`${file} set output: "standalone"`));
      await rm(join(dir, file));
    }
    // Other outputs, and a config Switchyard already changed, stay as they are.
    for (const config of ["export default { output: 'export' };\n", 'export default { output: (process.env.CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT ? undefined : "standalone") };\n']) {
      await writeFile(join(dir, "next.config.mjs"), config);
      await nextjsAdapter.convert({ dir, pm: "pnpm", run: fakeRunner().run, log: () => {}, options: { nextCache: "kv" } });
      expect(await readFile(join(dir, "next.config.mjs"), "utf8")).toBe(config);
    }
  });

  it("fails when vinext init fails", async () => {
    const { run } = fakeRunner(() => ({ code: 1, output: "incompatible" }));
    await expect(
      nextjsAdapter.convert({ dir: "/w", pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } }),
    ).rejects.toThrow("exited with code 1");
  });
});

describe("registry", () => {
  it("picks the Next.js adapter and reports others as unsupported for now", () => {
    expect(pickAdapter({ vercelFramework: "nextjs", packageJson: null }).adapter?.id).toBe("nextjs");
    expect(pickAdapter({ vercelFramework: "sveltekit", packageJson: {} })).toEqual({
      adapter: null,
      support: { level: "unsupported", reason: "sveltekit projects aren't supported yet" },
    });
    expect(supportForFramework(null)).toEqual({ level: "unsupported", reason: "Vercel didn't detect a framework" });
    expect(adapterById("nextjs")).toBe(pickAdapter({ vercelFramework: "nextjs", packageJson: null }).adapter);
    expect(adapterById("nope")).toBeNull();
  });
});
