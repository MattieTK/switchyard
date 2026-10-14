import { describe, expect, it } from "vitest";
import { detectVercelFeatures } from "../../src/translate/features.ts";
import { allDependencies, parsePackageJson } from "../../src/translate/package-json.ts";
import { addCommand, detectPackageManager, dlxCommand, execCommand, execString, installCommand } from "../../src/translate/package-manager.ts";
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
