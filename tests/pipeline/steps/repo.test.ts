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
        { id: "p", key: "API_KEY", value: "prod", type: "encrypted", target: ["production"] },
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
      ["clean", "-fdx", "-e", "node_modules"],
    ]);
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

  it("fails with the command's output when the build fails", async () => {
    const { run } = fakeRunner(() => ({ code: 1, output: "Type error" }));
    const { ctx } = makeContext({ deps: { run }, outputs: { convert: { projectDir: "/w/app" } } });
    await expect(buildStep.run(ctx)).rejects.toBeInstanceOf(CommandError);
  });
});
