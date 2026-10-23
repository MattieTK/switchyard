import { describe, expect, it } from "vitest";
import { detectVercelFeatures } from "../../src/translate/features.ts";
import { allDependencies, parsePackageJson } from "../../src/translate/package-json.ts";
import {
  addCommand,
  detectPackageManager,
  dlxCommand,
  execCommand,
  execString,
  installCommand,
  packageManagerVersionVariable,
  pnpmSwitchOffer,
} from "../../src/translate/package-manager.ts";
import { detectStorage } from "../../src/translate/storage.ts";
import { inferTokenScope } from "../../src/translate/token-scope.ts";

describe("package.json", () => {
  it("parses, and returns null for missing or invalid files", () => {
    expect(parsePackageJson('{"name":"a"}')).toEqual({ name: "a" });
    expect(parsePackageJson(null)).toBeNull();
    expect(parsePackageJson("{x")).toBeNull();
    expect(parsePackageJson("[]")).toBeNull();
  });

  it("drops fields with unexpected types", () => {
    expect(parsePackageJson('{"packageManager":123,"dependencies":"x","devDependencies":{"a":"1","b":2}}')).toEqual({
      devDependencies: { a: "1" },
    });
  });

  it("reads workspaces in the list and { packages } forms", () => {
    expect(parsePackageJson('{"workspaces":["apps/*",1]}')).toEqual({ workspaces: ["apps/*"] });
    expect(parsePackageJson('{"workspaces":{"packages":["packages/*"]}}')).toEqual({ workspaces: ["packages/*"] });
    expect(parsePackageJson('{"workspaces":"x"}')).toEqual({});
  });

  it("merges dependencies and devDependencies", () => {
    expect(allDependencies({ dependencies: { a: "1" }, devDependencies: { b: "2" } })).toEqual({ a: "1", b: "2" });
    expect(allDependencies(null)).toEqual({});
  });
});

describe("package manager", () => {
  it("prefers the packageManager field, then lockfiles, then npm", () => {
    expect(detectPackageManager(["yarn.lock"], { packageManager: "pnpm@10.33.0" })).toBe("pnpm");
    expect(detectPackageManager(["pnpm-lock.yaml"], {})).toBe("pnpm");
    expect(detectPackageManager(["yarn.lock"], {})).toBe("yarn");
    expect(detectPackageManager(["bun.lock"], {})).toBe("bun");
    expect(detectPackageManager([], null)).toBe("npm");
  });

  it("ignores a non-string packageManager field", () => {
    expect(detectPackageManager(["pnpm-lock.yaml"], parsePackageJson('{"packageManager":123}'))).toBe("pnpm");
  });

  it("builds add commands", () => {
    expect(addCommand("npm", ["a@^1", "b"])).toEqual({ cmd: "npm", args: ["install", "a@^1", "b"] });
    expect(addCommand("yarn", ["a@^1"])).toEqual({ cmd: "yarn", args: ["add", "a@^1"] });
  });

  it("builds install commands", () => {
    expect(installCommand("npm")).toEqual({ cmd: "npm", args: ["install"] });
    expect(installCommand("pnpm")).toEqual({ cmd: "pnpm", args: ["install"] });
    expect(installCommand("yarn")).toEqual({ cmd: "yarn", args: ["install"] });
    expect(installCommand("bun")).toEqual({ cmd: "bun", args: ["install"] });
  });

  it("builds exec and dlx commands", () => {
    expect(execCommand("pnpm", "cf", ["build"])).toEqual({ cmd: "pnpm", args: ["exec", "cf", "build"] });
    expect(execCommand("npm", "cf", ["build"])).toEqual({ cmd: "npx", args: ["--no-install", "cf", "build"] });
    expect(execString("yarn", "cf deploy --prebuilt")).toBe("yarn cf deploy --prebuilt");
    expect(dlxCommand("pnpm", "vinext@1.1.0", ["init"])).toEqual({ cmd: "pnpm", args: ["dlx", "vinext@1.1.0", "init"] });
    expect(dlxCommand("npm", "vinext@1.1.0", ["init"])).toEqual({ cmd: "npx", args: ["--yes", "vinext@1.1.0", "init"] });
    // Yarn 1 has no dlx, and npx works whichever Yarn the project uses.
    expect(dlxCommand("yarn", "vinext@1.1.0", ["init"])).toEqual({ cmd: "npx", args: ["--yes", "vinext@1.1.0", "init"] });
    expect(dlxCommand("bun", "vinext@1.1.0", ["init"])).toEqual({ cmd: "bunx", args: ["vinext@1.1.0", "init"] });
  });
});

describe("packageManagerVersionVariable", () => {
  it("gives the Workers Builds variable for the version packageManager asks for", () => {
    expect(packageManagerVersionVariable("pnpm@11.27.1+sha512.abc")).toEqual({ name: "PNPM_VERSION", value: "11.27.1" });
    expect(packageManagerVersionVariable("yarn@1.22.22")).toEqual({ name: "YARN_VERSION", value: "1.22.22" });
    expect(packageManagerVersionVariable("bun@1.4.3")).toEqual({ name: "BUN_VERSION", value: "1.4.3" });
  });

  it("gives nothing for npm, a missing field or a field without a version", () => {
    expect(packageManagerVersionVariable("npm@10.9.2")).toBeNull();
    expect(packageManagerVersionVariable(undefined)).toBeNull();
    expect(packageManagerVersionVariable("pnpm")).toBeNull();
  });
});

describe("pnpmSwitchOffer", () => {
  const offer = (pm: "npm" | "yarn" | "bun" | "pnpm", projectFiles: string[], packageJson = {}, rootFiles = projectFiles) =>
    pnpmSwitchOffer({ pm, packageJson, projectFiles, rootFiles });

  it("offers nothing to pnpm projects", () => {
    expect(offer("pnpm", ["pnpm-lock.yaml"])).toBeNull();
  });

  it("keeps versions from npm and Yarn lockfiles, and re-resolves for bun", () => {
    expect(offer("npm", ["package-lock.json"])).toEqual({ available: true, hint: null, reresolves: false });
    expect(offer("bun", ["bun.lock"])).toEqual({ available: true, hint: null, reresolves: true });
  });

  it("points out Yarn 1 and mixed lockfiles", () => {
    expect(offer("yarn", ["yarn.lock"])).toMatchObject({ hint: expect.stringContaining("Yarn 1") });
    expect(offer("yarn", ["yarn.lock"], { packageManager: "yarn@4.6.0" })).toMatchObject({ hint: null });
    expect(offer("yarn", ["yarn.lock", "package-lock.json"])).toMatchObject({
      hint: expect.stringContaining("more than one lockfile (package-lock.json, yarn.lock)"),
    });
  });

  it("isn't available for workspaces or a lockfile outside the project folder", () => {
    expect(offer("yarn", ["yarn.lock"], { workspaces: ["apps/*"] })).toEqual({
      available: false,
      reason: "This project uses yarn workspaces, and Switchyard can't move workspace settings to pnpm yet.",
    });
    expect(offer("npm", ["package.json"], {}, ["package-lock.json", "apps"])).toMatchObject({ available: false });
  });
});

describe("detectStorage", () => {
  it("finds Vercel Blob from env and dependency evidence", () => {
    const f = detectStorage({ envKeys: ["BLOB_READ_WRITE_TOKEN"], dependencies: { "@vercel/blob": "1" } });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "vercel-blob", evidence: ["BLOB_READ_WRITE_TOKEN", "@vercel/blob"] });
  });

  it("finds several stores and nothing when there is no evidence", () => {
    expect(
      detectStorage({ envKeys: ["KV_REST_API_URL", "POSTGRES_URL"], dependencies: { "@supabase/supabase-js": "2" } }).map(
        (f) => f.kind,
      ),
    ).toEqual(["vercel-kv", "vercel-postgres", "supabase"]);
    expect(detectStorage({ envKeys: ["API_KEY"], dependencies: { react: "19" } })).toEqual([]);
  });
});

describe("detectVercelFeatures", () => {
  it("lists Vercel-only packages", () => {
    expect(detectVercelFeatures({ "@vercel/analytics": "1", "@vercel/og": "1", next: "16" }).map((f) => f.package)).toEqual([
      "@vercel/analytics",
      "@vercel/og",
    ]);
  });
});

describe("inferTokenScope", () => {
  const team = { id: "t", slug: "acme", name: "Acme" };

  it("treats a token that can read the user as full-account", () => {
    expect(inferTokenScope({ userOk: true, user: null, teams: [team], projectsOk: true })).toEqual({
      kind: "account",
      teams: [team],
    });
  });

  it("treats a token that lists projects but not the user as team-scoped", () => {
    expect(inferTokenScope({ userOk: false, user: null, teams: null, projectsOk: true })).toEqual({ kind: "team" });
  });

  it("treats a token that can't list projects as too limited", () => {
    expect(inferTokenScope({ userOk: true, user: null, teams: [], projectsOk: false })).toEqual({ kind: "limited" });
  });
});
