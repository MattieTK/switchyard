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
    expect(calls[0]?.opts).toMatchObject({ cwd: dir, env: { npm_config_legacy_peer_deps: "true" } });
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

  it("warns when pnpm blocked build scripts", async () => {
    const { run } = fakeRunner(() => ({ code: 0, output: "Run pnpm approve-builds to review" }));
    const r = await nextjsAdapter.convert({ dir: "/w", pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(r.warnings[0]).toContain("pnpm approve-builds");
  });

  it("warns in the plan when the app's Next.js is older than 16", () => {
    const [warning, ...rest] = nextjsAdapter.planWarnings?.({ dependencies: { next: "10.0.2" } }) ?? [];
    expect(rest).toEqual([]);
    expect(warning).toBe(
      "This app uses Next.js 10. Switchyard will upgrade it to Next.js 16.4.1 with the official Next.js codemods before converting, because vinext needs Next.js 16. Upgrading across major versions can change how the app behaves, so review the pull request and test the preview before switching traffic.",
    );
    expect(nextjsAdapter.planWarnings?.({ dependencies: { next: "^16.1.0" } })).toEqual([]);
    expect(nextjsAdapter.planWarnings?.({ dependencies: { next: "canary" } })).toEqual([]);
    expect(nextjsAdapter.planWarnings?.(null)).toEqual([]);
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

  describe("module type", () => {
    // Does what vinext init does to package.json and the Vite config.
    const initLikeVinext = (config = "vite.config.ts") =>
      fakeRunner(async (_cmd, args) => {
        if (args.includes("init")) {
          const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
          await writeFile(join(dir, "package.json"), JSON.stringify({ ...manifest, type: "module" }));
          await writeFile(join(dir, config), "export default {};\n");
        }
        return { code: 0, output: "" };
      });
    const manifest = async () => JSON.parse(await readFile(join(dir, "package.json"), "utf8"));

    it("keeps the project's module type and makes the Vite config an ES module file", async () => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "16.2.0" } }));
      await nextjsAdapter.convert({ dir, pm: "pnpm", run: initLikeVinext().run, log: () => {}, options: { nextCache: "kv" } });
      expect(await manifest()).not.toHaveProperty("type");
      expect(await readFile(join(dir, "vite.config.mts"), "utf8")).toBe("export default {};\n");
      await expect(readFile(join(dir, "vite.config.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("puts back an explicit commonjs type and renames a .js Vite config to .mjs", async () => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ type: "commonjs", dependencies: { next: "16.2.0" } }));
      const { run } = initLikeVinext("vite.config.js");
      await nextjsAdapter.convert({ dir, pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
      expect((await manifest()).type).toBe("commonjs");
      expect(await readFile(join(dir, "vite.config.mjs"), "utf8")).toBe("export default {};\n");
    });

    it("leaves an app that was already an ES module as it is", async () => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module", dependencies: { next: "16.2.0" } }));
      await nextjsAdapter.convert({ dir, pm: "pnpm", run: initLikeVinext().run, log: () => {}, options: { nextCache: "kv" } });
      expect((await manifest()).type).toBe("module");
      expect(await readFile(join(dir, "vite.config.ts"), "utf8")).toBe("export default {};\n");
    });
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
