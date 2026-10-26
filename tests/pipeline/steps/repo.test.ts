import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../../../src/adapters/types.ts";
import { CommandError } from "../../../src/exec.ts";
import { buildStep, cloneStep, convertStep } from "../../../src/pipeline/steps/repo.ts";
import { buildEnvPlan } from "../../../src/translate/env-plan.ts";
import { fakeRunner } from "../../helpers/fake-runner.ts";
import { makeContext } from "../../helpers/step-context.ts";
import { makeTempDir } from "../../helpers/tmp.ts";

const VINEXT_CONFIG = `import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "probe",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-10-14",
    env: { ASSETS: bindings.assets() },
  }),
});
`;

describe("cloneStep", () => {
  it("clones the production branch with header auth and creates the migration branch", async () => {
    const workDir = await makeTempDir();
    const { run, calls } = fakeRunner();
    const { ctx, job, secrets } = makeContext({ deps: { run, workDir } });
    await cloneStep.run(ctx);
    const dir = join(workDir, job.id);
    expect(calls[0]?.args).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      "https://github.com/acme/shop.git",
      dir,
    ]);
    expect(calls[0]?.opts?.env?.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(calls[1]).toMatchObject({ args: ["checkout", "-B", "cloudflare-migration", "origin/main"], opts: { cwd: dir } });
    expect(ctx.outputs.dir).toBe(dir);
    expect(secrets).toContain("gh-token");
  });

  it("fetches instead of cloning when the working copy already exists", async () => {
    const workDir = await makeTempDir();
    const { run, calls } = fakeRunner();
    const { ctx, job } = makeContext({ deps: { run, workDir } });
    await mkdir(join(workDir, job.id, ".git"), { recursive: true });
    await cloneStep.run(ctx);
    expect(calls[0]?.args).toEqual(["fetch", "--depth", "1", "origin", "main"]);
  });
});

describe("convertStep", () => {
  it("resets the checkout, runs the adapter and applies Switchyard's edits", async () => {
    const repoDir = await makeTempDir();
    const { run, calls } = fakeRunner();
    const adapter: Adapter = {
      id: "nextjs",
      label: "Next.js",
      support: { level: "supported" },
      reservedBindings: ["ASSETS"],
      matches: () => true,
      async convert(c) {
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "vinext/server/fetch-handler", warnings: ["heads up"] };
      },
    };
    const { plan: env, values } = buildEnvPlan(
      [
        { id: "p", key: "API_KEY", value: "prod", type: "encrypted", decrypted: true, target: ["production"] },
        { id: "d", key: "LOCAL", value: "dev", type: "plain", target: ["development"] },
      ],
      ["ASSETS"],
    );
    const { ctx } = makeContext({
      plan: { env, vercelJson: { crons: [{ path: "/api/cron", schedule: "0 * * * *" }], manual: [] } },
      values,
      deps: { run, adapter: () => adapter },
      outputs: { clone: { dir: repoDir } },
    });

    await convertStep.run(ctx);

    expect(calls.map((c) => c.args)).toEqual([
      ["reset", "--hard", "origin/main"],
      ["clean", "-fdx"],
      ["ls-files", "-z", "--", "*.js", "*.jsx", "*.ts", "*.tsx", "*.mjs", "*.cjs"],
      ["ignored-builds"],
      ["ls-files", "--", ".dev.vars"],
    ]);
    expect(calls[4]?.opts?.cwd).toBe(repoDir);
    const config = await readFile(join(repoDir, "cloudflare.config.ts"), "utf8");
    expect(config).toContain('name: "shop"');
    expect(config).toContain("API_KEY: bindings.secret()");
    expect(config).toContain('entrypoint: "./switchyard-entry.ts"');
    expect(await readFile(join(repoDir, "switchyard-entry.ts"), "utf8")).toContain('"/api/cron"');
    expect(await readFile(join(repoDir, ".dev.vars"), "utf8")).toBe("LOCAL='dev'\n");
    expect((await stat(join(repoDir, ".dev.vars"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(repoDir, ".gitignore"), "utf8")).toContain(".dev.vars");
    expect(ctx.outputs).toEqual({ projectDir: repoDir, warnings: '["heads up"]' });
  });

  it("passes the chosen upgrade options to the adapter, and defaults for older job files", async () => {
    const seen: unknown[] = [];
    const adapter = {
      convert: async (c: { dir: string; options: unknown }) => {
        seen.push(c.options);
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "x", warnings: [] };
      },
    } as unknown as Adapter;
    for (const options of [
      { adoptionCodemods: false, eslintMigration: true, updateFlaggedPackages: true, switchToPnpm: false },
      undefined,
    ]) {
      const { ctx } = makeContext({
        plan: { ...(options ? { options } : {}) },
        deps: { run: fakeRunner().run, adapter: () => adapter },
        outputs: { clone: { dir: await makeTempDir() } },
      });
      await convertStep.run(ctx);
    }
    expect(seen).toEqual([
      { nextCache: "kv", adoptionCodemods: false, eslintMigration: true, updateFlaggedPackages: true },
      { nextCache: "kv", adoptionCodemods: false, eslintMigration: false, updateFlaggedPackages: false },
    ]);
  });

  it("doesn't write development values to a .dev.vars that is tracked in git", async () => {
    const repoDir = await makeTempDir();
    await writeFile(join(repoDir, ".dev.vars"), "COMMITTED='original'\n");
    const { run } = fakeRunner((_cmd, args) => ({ code: 0, output: args[0] === "ls-files" ? ".dev.vars\n" : "" }));
    const adapter = {
      convert: async (c: { dir: string }) => {
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "x", warnings: [] };
      },
    } as unknown as Adapter;
    const { plan: env, values } = buildEnvPlan(
      [{ id: "d", key: "LOCAL", value: "dev", type: "plain", target: ["development"] }],
      [],
    );
    const { ctx, logs } = makeContext({
      plan: { env },
      values,
      deps: { run, adapter: () => adapter },
      outputs: { clone: { dir: repoDir } },
    });
    await convertStep.run(ctx);
    expect(await readFile(join(repoDir, ".dev.vars"), "utf8")).toBe("COMMITTED='original'\n");
    expect(logs).toContain(
      "Warning: .dev.vars is tracked in git, so Switchyard didn't write development values to it.",
    );
  });

  it("raises a low Node.js pin and allows build scripts of packages the conversion added, in the project and at the repository root", async () => {
    const repoDir = await makeTempDir();
    await mkdir(join(repoDir, "apps/web"), { recursive: true });
    await writeFile(join(repoDir, ".nvmrc"), "v20.19.6\n");
    await writeFile(join(repoDir, "apps/web/.node-version"), "24\n");
    await writeFile(
      join(repoDir, "pnpm-workspace.yaml"),
      "allowBuilds:\n  workerd: set this to true or false\n  sharp: set this to true or false\n",
    );
    const adapter = {
      convert: async (c: { dir: string }) => {
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "x", warnings: [] };
      },
    } as unknown as Adapter;
    // The production branch's lockfile already had sharp, but not workerd.
    const { run } = fakeRunner((_cmd, args) =>
      args[0] === "show" && args[1] === "origin/main:pnpm-lock.yaml"
        ? { code: 0, output: "packages:\n\n  sharp@0.34.3:\n    resolution: {}\n" }
        : { code: args[0] === "show" ? 128 : 0, output: "" },
    );
    const { ctx } = makeContext({
      plan: { repo: { owner: "acme", name: "shop", productionBranch: "main", rootDirectory: "apps/web" } },
      deps: { run, adapter: () => adapter },
      outputs: { clone: { dir: repoDir } },
    });
    await convertStep.run(ctx);
    expect(await readFile(join(repoDir, ".nvmrc"), "utf8")).toBe("22\n");
    expect(await readFile(join(repoDir, "apps/web/.node-version"), "utf8")).toBe("24\n");
    expect(await readFile(join(repoDir, "pnpm-workspace.yaml"), "utf8")).toBe(
      "allowBuilds:\n  workerd: true\n  sharp: false\n",
    );
    expect(JSON.parse(ctx.outputs.warnings ?? "[]")).toEqual([
      "Switchyard changed .nvmrc from v20.19.6 to 22, because Cloudflare's build tools need Node.js 22 or later and Workers Builds uses the version in this file. Check the app still works on Node.js 22.",
      "Switchyard allowed the build scripts of workerd in pnpm-workspace.yaml. The conversion added these packages, and pnpm stops installing until each build script is allowed or refused. Change any to false if you'd rather not run it.",
      "Switchyard set the build scripts of sharp to false in pnpm-workspace.yaml, because pnpm already skipped them before the migration, and pnpm stops installing until each is allowed or refused. Change any to true if the app needs it.",
    ]);
  });

  it("decides on the build scripts pnpm 12 skipped, keeping what happened on Vercel for the project's own", async () => {
    // pnpm 12 writes no placeholders, and an install with CI set fails with ERR_PNPM_IGNORED_BUILDS.
    const adapter = {
      convert: async (c: { dir: string }) => {
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "x", warnings: [] };
      },
    } as unknown as Adapter;
    const IGNORED = "Automatically ignored builds during installation:\n  unrs-resolver\n  workerd\n  sharp\nhint: …\n";
    // In each case the production branch's lockfile already had sharp, but not workerd or unrs-resolver.
    for (const [switchedFrom, lockfile, lock, sharp, sharpWarning] of [
      [
        undefined,
        "pnpm-lock.yaml",
        "packages:\n\n  sharp@0.34.3:\n    resolution: {}\n",
        false,
        "Switchyard set the build scripts of sharp to false in pnpm-workspace.yaml, because pnpm already skipped them before the migration, and pnpm stops installing until each is allowed or refused. Change any to true if the app needs it.",
      ],
      [
        "yarn",
        "yarn.lock",
        '# yarn lockfile v1\n\n\nsharp@^0.34.3:\n  version "0.34.3"\n',
        true,
        "Switchyard allowed the build scripts of sharp in pnpm-workspace.yaml, because yarn ran them when Vercel installed the project, and pnpm stops installing until each is allowed or refused. Change any to false if the app doesn't need it.",
      ],
    ] as const) {
      const repoDir = await makeTempDir();
      await writeFile(join(repoDir, "pnpm-workspace.yaml"), "shamefullyHoist: true\n");
      await writeFile(join(repoDir, "package.json"), "{}");
      const { run, calls } = fakeRunner((_cmd, args) => {
        if (args[0] === "ignored-builds") return { code: 0, output: IGNORED };
        if (args[0] === "--version") return { code: 0, output: "12.15.0\n" };
        if (args[0] === "show" && args[1] === `origin/main:${lockfile}`) return { code: 0, output: lock };
        return { code: args[0] === "show" ? 128 : 0, output: "" };
      });
      const { ctx } = makeContext({
        plan: switchedFrom ? { switchedFrom } : {},
        deps: { run, adapter: () => adapter },
        outputs: { clone: { dir: repoDir } },
      });
      await convertStep.run(ctx);
      expect(calls.find((c) => c.args[0] === "ignored-builds")).toMatchObject({ cmd: "pnpm", opts: { cwd: repoDir } });
      expect(await readFile(join(repoDir, "pnpm-workspace.yaml"), "utf8")).toBe(
        `shamefullyHoist: true\n\nallowBuilds:\n  "unrs-resolver": true\n  "workerd": true\n  "sharp": ${sharp}\n`,
      );
      const warnings = JSON.parse(ctx.outputs.warnings ?? "[]") as string[];
      expect(warnings).toContain(
        "Switchyard allowed the build scripts of unrs-resolver, workerd in pnpm-workspace.yaml. The conversion added these packages, and pnpm stops installing until each build script is allowed or refused. Change any to false if you'd rather not run it.",
      );
      expect(warnings).toContain(sharpWarning);
    }
  });

  it("keeps a Yarn 1 project on Yarn 1 by naming it in package.json before setting Yarn up", async () => {
    const repoDir = await makeTempDir();
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "shop" }));
    await writeFile(join(repoDir, "yarn.lock"), "# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n\n");
    let declared: unknown;
    const adapter = {
      convert: async (c: { dir: string }) => {
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "x", warnings: [] };
      },
    } as unknown as Adapter;
    const { ctx } = makeContext({
      plan: { packageManager: "yarn" },
      deps: {
        run: fakeRunner().run,
        adapter: () => adapter,
        ensurePackageManager: async (_pm, cwd) => {
          declared = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).packageManager;
        },
      },
      outputs: { clone: { dir: repoDir } },
    });
    await convertStep.run(ctx);
    expect(declared).toBe("yarn@1.22.22");
    expect(JSON.parse(ctx.outputs.warnings ?? "[]")[0]).toContain("set packageManager to yarn@1.22.22");
  });

  it("leaves Yarn alone when package.json names a version or the lockfile is Yarn 2 or later", async () => {
    for (const [pkg, lock] of [
      [{ packageManager: "yarn@4.6.0" }, "# yarn lockfile v1\n"],
      [{}, "__metadata:\n  version: 8\n"],
    ] as const) {
      const repoDir = await makeTempDir();
      await writeFile(join(repoDir, "package.json"), JSON.stringify(pkg));
      await writeFile(join(repoDir, "yarn.lock"), lock);
      const adapter = {
        convert: async (c: { dir: string }) => {
          await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
          return { baseEntrypoint: "x", warnings: [] };
        },
      } as unknown as Adapter;
      const { ctx } = makeContext({
        plan: { packageManager: "yarn" },
        deps: { run: fakeRunner().run, adapter: () => adapter },
        outputs: { clone: { dir: repoDir } },
      });
      await convertStep.run(ctx);
      expect(JSON.parse(await readFile(join(repoDir, "package.json"), "utf8"))).toEqual(pkg);
    }
  });

  describe("switching to pnpm", () => {
    const adapter = {
      convert: async (c: { dir: string }) => {
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "x", warnings: [] };
      },
    } as unknown as Adapter;
    const pnpm = (importCode = 0) =>
      fakeRunner((cmd, args) =>
        cmd === "pnpm" && args[0] === "import"
          ? { code: importCode, output: "" }
          : cmd === "pnpm" && args[0] === "--version"
            ? { code: 0, output: "11.27.1\n" }
            : { code: 0, output: "" },
      );
    const switching = (from: "yarn" | "bun", repoDir: string, run: ReturnType<typeof pnpm>["run"], order: string[] = []) =>
      makeContext({
        plan: { packageManager: "pnpm", switchedFrom: from },
        deps: {
          run,
          adapter: () => adapter,
          ensurePackageManager: async (pm) => {
            order.push(`ensure ${pm}`);
          },
        },
        outputs: { clone: { dir: repoDir } },
      }).ctx;

    it("imports a Yarn lockfile, removes it and names pnpm in package.json", async () => {
      const repoDir = await makeTempDir();
      await writeFile(
        join(repoDir, "package.json"),
        JSON.stringify({ packageManager: "yarn@1.22.22", scripts: { build: "yarn generate && next build", generate: "node g.js" } }),
      );
      await writeFile(join(repoDir, "yarn.lock"), "# yarn lockfile v1\n");
      await writeFile(join(repoDir, ".yarnrc.yml"), "nodeLinker: node-modules\n");
      const order: string[] = [];
      const { run, calls } = pnpm();
      const ctx = switching("yarn", repoDir, run, order);
      await convertStep.run(ctx);
      expect(order[0]).toBe("ensure pnpm");
      expect(calls.find((c) => c.args[0] === "import")).toMatchObject({ cmd: "pnpm", opts: { cwd: repoDir } });
      await expect(stat(join(repoDir, "yarn.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(join(repoDir, "package.json"), "utf8")).packageManager).toBe("pnpm@11.27.1");
      expect(await readFile(join(repoDir, "pnpm-workspace.yaml"), "utf8")).toBe("shamefullyHoist: true\n");
      expect(await readFile(join(repoDir, ".npmrc"), "utf8")).toBe("shamefully-hoist=true\n");
      expect(JSON.parse(ctx.outputs.warnings ?? "[]")).toEqual([
        "Switchyard moved the project from yarn to pnpm with pnpm import, which keeps the dependency versions from yarn.lock, and set packageManager to pnpm@11.27.1.",
        "Switchyard turned on shamefullyHoist in pnpm-workspace.yaml and .npmrc, so packages the app imports without declaring stay reachable, as they were with yarn. Once package.json lists everything the app imports, you can remove it.",
        "The build script calls yarn or bun directly. Change it to use pnpm.",
        "pnpm doesn't use .yarnrc.yml. Remove it once the move is settled.",
      ]);
    });

    it("can't import a bun lockfile, so pnpm resolves versions again", async () => {
      const repoDir = await makeTempDir();
      await writeFile(join(repoDir, "package.json"), "{}");
      await writeFile(join(repoDir, "bun.lock"), "{}");
      const { run, calls } = pnpm();
      const ctx = switching("bun", repoDir, run);
      await convertStep.run(ctx);
      expect(calls.some((c) => c.args[0] === "import")).toBe(false);
      await expect(stat(join(repoDir, "bun.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(ctx.outputs.warnings ?? "[]")[0]).toBe(
        "Switchyard moved the project from bun to pnpm and set packageManager to pnpm@11.27.1. bun.lock can't be imported, so pnpm chose dependency versions again. Test the app before merging.",
      );
    });

    it("stops when pnpm import fails", async () => {
      const repoDir = await makeTempDir();
      await writeFile(join(repoDir, "package.json"), "{}");
      await writeFile(join(repoDir, "yarn.lock"), "__metadata:\n  version: 8\n");
      await expect(convertStep.run(switching("yarn", repoDir, pnpm(1).run))).rejects.toThrow(
        "pnpm couldn't import yarn.lock (pnpm import exited with code 1). Check the log, or build the plan again without Switch to pnpm.",
      );
    });

    it("reads the original manager's lockfile for packages installed before the migration", async () => {
      const repoDir = await makeTempDir();
      await writeFile(join(repoDir, "package.json"), "{}");
      await writeFile(join(repoDir, "pnpm-workspace.yaml"), "allowBuilds:\n  sharp: set this to true or false\n");
      const { run } = fakeRunner((_cmd, args) =>
        args[0] === "show"
          ? args[1] === "origin/main:yarn.lock"
            ? { code: 0, output: 'sharp@^0.33.0:\n  version "0.33.5"\n' }
            : { code: 128, output: "" }
          : { code: 0, output: args[0] === "--version" ? "11.27.1\n" : "" },
      );
      await convertStep.run(switching("yarn", repoDir, run));
      // The project had sharp before, and Yarn ran its build script on Vercel, so it stays allowed.
      expect(await readFile(join(repoDir, "pnpm-workspace.yaml"), "utf8")).toContain("  sharp: true\n");
    });
  });

  it("replaces fetch polyfill imports in the project's tracked source files with the built-in fetch", async () => {
    const repoDir = await makeTempDir();
    await mkdir(join(repoDir, "pages"), { recursive: true });
    await writeFile(join(repoDir, "pages/index.js"), 'import fetch from "isomorphic-fetch";\nexport const a = () => fetch("/x");\n');
    await writeFile(join(repoDir, "pages/other.js"), 'import fetch, { FetchError } from "node-fetch";\nexport { fetch, FetchError };\n');
    const adapter = {
      convert: async (c: { dir: string }) => {
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "x", warnings: [] };
      },
    } as unknown as Adapter;
    const { run } = fakeRunner((_cmd, args) =>
      args[0] === "ls-files" && args.includes("-z")
        ? { code: 0, output: "pages/index.js\0pages/other.js\0README.md\0" }
        : { code: args[0] === "show" ? 128 : 0, output: "" },
    );
    const { ctx } = makeContext({ deps: { run, adapter: () => adapter }, outputs: { clone: { dir: repoDir } } });
    await convertStep.run(ctx);
    expect(await readFile(join(repoDir, "pages/index.js"), "utf8")).toBe('export const a = () => fetch("/x");\n');
    expect(await readFile(join(repoDir, "pages/other.js"), "utf8")).toContain('from "node-fetch"');
    const warnings = JSON.parse(ctx.outputs.warnings ?? "[]") as string[];
    expect(warnings).toContainEqual(expect.stringContaining("Switchyard replaced the imports of isomorphic-fetch in pages/index.js with the fetch built into Workers"));
    expect(warnings).toContainEqual(expect.stringContaining("pages/other.js still imports node-fetch"));
  });

  it("removes lockfiles of package managers the project doesn't use", async () => {
    const repoDir = await makeTempDir();
    for (const f of ["package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"]) await writeFile(join(repoDir, f), "{}");
    const adapter = {
      convert: async (c: { dir: string }) => {
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "x", warnings: [] };
      },
    } as unknown as Adapter;
    const { ctx } = makeContext({
      plan: { packageManager: "pnpm" },
      deps: { run: fakeRunner().run, adapter: () => adapter },
      outputs: { clone: { dir: repoDir } },
    });
    await convertStep.run(ctx);
    await expect(stat(join(repoDir, "yarn.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(repoDir, "package-lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(repoDir, "pnpm-lock.yaml"))).isFile()).toBe(true);
    expect(JSON.parse(ctx.outputs.warnings ?? "[]")).toContainEqual(
      "The project had lockfiles for more than one package manager. Switchyard kept pnpm's, the one it detected, and removed package-lock.json, yarn.lock, because the Cloudflare build tools could otherwise pick another package manager.",
    );
  });

  it("works inside the project's root directory", async () => {
    const repoDir = await makeTempDir();
    await mkdir(join(repoDir, "apps/web"), { recursive: true });
    const adapter = {
      convert: async (c: { dir: string }) => {
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "x", warnings: [] };
      },
    } as unknown as Adapter;
    const { ctx } = makeContext({
      plan: { repo: { owner: "acme", name: "shop", productionBranch: "main", rootDirectory: "apps/web" } },
      deps: { adapter: () => adapter },
      outputs: { clone: { dir: repoDir } },
    });
    await convertStep.run(ctx);
    expect(ctx.outputs.projectDir).toBe(join(repoDir, "apps/web"));
  });

  it("makes sure the project's package manager can run before converting", async () => {
    const repoDir = await makeTempDir();
    const order: string[] = [];
    const adapter = {
      convert: async (c: { dir: string }) => {
        order.push("convert");
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "x", warnings: [] };
      },
    } as unknown as Adapter;
    const { ctx } = makeContext({
      plan: { packageManager: "yarn" },
      deps: {
        adapter: () => adapter,
        ensurePackageManager: async (pm, cwd) => {
          order.push(`ensure ${pm} ${cwd}`);
        },
      },
      outputs: { clone: { dir: repoDir } },
    });
    await convertStep.run(ctx);
    expect(order).toEqual([`ensure yarn ${repoDir}`, "convert"]);
  });

  it("fails clearly when the converter produced no cloudflare.config.ts", async () => {
    const repoDir = await makeTempDir();
    const adapter = { convert: async () => ({ baseEntrypoint: "x", warnings: [] }) } as unknown as Adapter;
    const { ctx } = makeContext({ deps: { adapter: () => adapter }, outputs: { clone: { dir: repoDir } } });
    await expect(convertStep.run(ctx)).rejects.toThrow("didn't create cloudflare.config.ts");
  });
});

describe("buildStep", () => {
  it("runs cf build through the project's package manager", async () => {
    const { run, calls } = fakeRunner();
    const { ctx } = makeContext({ deps: { run }, outputs: { convert: { projectDir: "/w/app" } } });
    await buildStep.run(ctx);
    expect(calls[0]).toMatchObject({ cmd: "pnpm", args: ["exec", "cf", "build"], opts: { cwd: "/w/app", env: { CI: "1" } } });
  });

  it("runs the build:cloudflare script when the conversion added one", async () => {
    const { run, calls } = fakeRunner();
    const { ctx } = makeContext({
      deps: { run },
      outputs: { convert: { projectDir: "/w/app", buildScript: "build:cloudflare" } },
    });
    await buildStep.run(ctx);
    expect(calls[0]).toMatchObject({ cmd: "pnpm", args: ["run", "build:cloudflare"], opts: { cwd: "/w/app" } });
  });

  it("passes the production build variables to the build, with CI still set", async () => {
    const { plan: env, values } = buildEnvPlan(
      [
        { id: "a", key: "NEXT_PUBLIC_API", value: "https://api.example.com", type: "plain", target: ["production"] },
        { id: "b", key: "CI", value: "0", type: "plain", target: ["production"] },
        { id: "c", key: "PREVIEW_ONLY", value: "x", type: "plain", target: ["preview"] },
      ],
      [],
    );
    const { run, calls } = fakeRunner();
    const { ctx } = makeContext({
      plan: { env },
      values,
      deps: { run },
      outputs: { convert: { projectDir: "/w/app" } },
    });
    await buildStep.run(ctx);
    expect(calls[0]?.opts?.env).toEqual({ NEXT_PUBLIC_API: "https://api.example.com", CI: "1" });
  });

  it("adds packages that dependencies import without declaring, at their previous version, and builds again", async () => {
    const projectDir = await makeTempDir();
    const failure = `Error: [vite]: Rolldown failed to resolve import "@babel/runtime/regenerator" from "${projectDir}/node_modules/react-twitter-widgets/es/index.js".`;
    let builds = 0;
    const { run, calls } = fakeRunner((cmd, args) => {
      if (args.includes("build")) return { code: builds++ === 0 ? 1 : 0, output: builds === 1 ? failure : "Build complete" };
      if (cmd === "git" && args[0] === "show") {
        return args[1] === "origin/main:yarn.lock"
          ? { code: 0, output: '"@babel/runtime@7.12.5":\n  version "7.12.5"\n' }
          : { code: 128, output: "fatal: path does not exist" };
      }
      return { code: 0, output: "" };
    });
    const { ctx, logs } = makeContext({
      plan: { packageManager: "yarn" },
      deps: { run },
      outputs: { clone: { dir: projectDir }, convert: { projectDir } },
    });
    await buildStep.run(ctx);
    expect(calls.filter((c) => c.cmd === "yarn").map((c) => c.args)).toEqual([
      ["cf", "build"],
      ["add", "@babel/runtime@^7.12.5"],
      ["cf", "build"],
    ]);
    const warning =
      "react-twitter-widgets imports @babel/runtime without listing it as a dependency, so the build couldn't find it. Switchyard added @babel/runtime@^7.12.5, the version the project had installed before, to package.json.";
    expect(JSON.parse(ctx.outputs.warnings ?? "[]")).toEqual([warning]);
    expect(logs).toContain(`Warning: ${warning}`);
  });

  it("adds the latest release when the project never had the package, and says so", async () => {
    const projectDir = await makeTempDir();
    const failure = `Rolldown failed to resolve import "tiny-warning" from "${projectDir}/node_modules/lib/index.js".`;
    let builds = 0;
    const { run, calls } = fakeRunner((cmd, args) => {
      if (args.includes("build")) return { code: builds++ === 0 ? 1 : 0, output: builds === 1 ? failure : "" };
      if (cmd === "git") return { code: 128, output: "" };
      return { code: 0, output: "" };
    });
    const { ctx } = makeContext({ deps: { run }, outputs: { clone: { dir: projectDir }, convert: { projectDir } } });
    await buildStep.run(ctx);
    expect(calls.find((c) => c.args[0] === "add")?.args).toEqual(["add", "tiny-warning"]);
    expect(JSON.parse(ctx.outputs.warnings ?? "[]")[0]).toContain("Switchyard added the latest tiny-warning");
  });

  it("gives up when the missing package is already installed, so the failure is something else", async () => {
    const projectDir = await makeTempDir();
    await mkdir(join(projectDir, "node_modules/tiny-warning"), { recursive: true });
    await writeFile(join(projectDir, "node_modules/tiny-warning/package.json"), "{}");
    const failure = `Rolldown failed to resolve import "tiny-warning/sub" from "${projectDir}/node_modules/lib/index.js".`;
    const { run, calls } = fakeRunner(() => ({ code: 1, output: failure }));
    const { ctx } = makeContext({ deps: { run }, outputs: { clone: { dir: projectDir }, convert: { projectDir } } });
    await expect(buildStep.run(ctx)).rejects.toBeInstanceOf(CommandError);
    expect(calls).toHaveLength(1);
  });

  it("fails with the command's output when the build fails", async () => {
    const { run } = fakeRunner(() => ({ code: 1, output: "Type error" }));
    const { ctx } = makeContext({ deps: { run }, outputs: { convert: { projectDir: "/w/app" } } });
    await expect(buildStep.run(ctx)).rejects.toBeInstanceOf(CommandError);
  });
});
