import { readFile, rm, writeFile } from "node:fs/promises";
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
    expect(calls[0]?.opts?.env).toBeUndefined();
    await expect(readFile(join(dir, ".npmrc"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
