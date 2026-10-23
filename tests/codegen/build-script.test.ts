import { describe, expect, it } from "vitest";
import { cloudflareBuildScript } from "../../src/codegen/build-script.ts";

const run = (name: string) => `npm run ${name}`;

describe("cloudflareBuildScript", () => {
  it("needs no script when the build is only next build", () => {
    expect(cloudflareBuildScript({ build: "next build" }, run)).toEqual({ script: null, warnings: [] });
    expect(cloudflareBuildScript({ build: "next build --turbopack" }, run)).toEqual({ script: null, warnings: [] });
    expect(cloudflareBuildScript(undefined, run)).toEqual({ script: null, warnings: [] });
  });

  it("keeps the steps before next build", () => {
    expect(cloudflareBuildScript({ build: "prisma generate && next build" }, run)).toEqual({
      script: "prisma generate && cf build",
      warnings: [],
    });
  });

  it("runs the prebuild script, which npm runs before build", () => {
    expect(cloudflareBuildScript({ prebuild: "npm run generate", build: "next build" }, run)).toEqual({
      script: "npm run prebuild && cf build",
      warnings: [],
    });
  });

  it("keeps settings written before next build", () => {
    expect(cloudflareBuildScript({ build: "NODE_OPTIONS=--max-old-space-size=4096 next build" }, run).script).toBe(
      "NODE_OPTIONS=--max-old-space-size=4096 cf build",
    );
    expect(cloudflareBuildScript({ build: "contentlayer build && cross-env NODE_ENV=production next build" }, run).script).toBe(
      "contentlayer build && cross-env NODE_ENV=production cf build",
    );
  });

  it("leaves out and reports steps after next build", () => {
    const r = cloudflareBuildScript({ build: "next build && next-sitemap", postbuild: "node scripts/ping.js" }, run);
    expect(r.script).toBeNull();
    expect(r.warnings).toEqual([
      "Switchyard left out the steps that run after `next build` (`next-sitemap && npm run postbuild`), because they expect Next.js's own build output, which the Cloudflare build doesn't produce. Check whether the app still needs what they generate.",
    ]);
  });

  it("falls back to cf build when the build script can't be read", () => {
    for (const build of ["turbo run build", "next lint; next build", "a || next build", "a | next build"]) {
      const r = cloudflareBuildScript({ prebuild: "gen", build }, run);
      expect(r.script).toBe("npm run prebuild && cf build");
      expect(r.warnings[0]).toContain(`couldn't find \`next build\` in the build script (\`${build}\`)`);
    }
  });
});

describe("cloudflareBuildScript with scripts that call scripts", () => {
  it("follows run-s to the script that runs next build", () => {
    const scripts = {
      build: "run-s db:prod:migrate codegen next:build",
      "db:prod:migrate": "prisma migrate deploy",
      codegen: "wagmi generate",
      "next:build": "next build",
    };
    expect(cloudflareBuildScript(scripts, run)).toEqual({
      script: "npm run db:prod:migrate && npm run codegen && cf build",
      warnings: [],
    });
  });

  it("follows npm run, pnpm and yarn shorthands, and keeps the called script's pre-script", () => {
    const scripts = {
      build: "npm run generate && npm run build:next",
      generate: "node gen.js",
      prebuild_next: "x",
      "prebuild:next": "node check.js",
      "build:next": "contentlayer build && next build",
    };
    expect(cloudflareBuildScript(scripts, run).script).toBe(
      "npm run generate && npm run prebuild:next && contentlayer build && cf build",
    );
    expect(cloudflareBuildScript({ build: "yarn compile", compile: "next build" }, run)).toEqual({ script: null, warnings: [] });
    expect(cloudflareBuildScript({ build: "pnpm gen && pnpm compile", gen: "g", compile: "next build" }, run).script).toBe(
      "pnpm gen && cf build",
    );
  });

  it("expands npm-run-all patterns in script order", () => {
    const scripts = { build: "npm-run-all -s gen:* next", "gen:icons": "a", "gen:types": "b", "gen:x:y": "c", next: "next build" };
    expect(cloudflareBuildScript(scripts, run).script).toBe("npm run gen:icons && npm run gen:types && cf build");
  });

  it("falls back to cf build for parallel runs, loops and scripts that don't exist", () => {
    const cases: Record<string, string>[] = [
      { build: "run-p gen next", gen: "a", next: "next build" },
      { build: "npm-run-all --parallel gen next", gen: "a", next: "next build" },
      { build: "npm run a", a: "npm run b", b: "npm run a" },
      { build: "npm run missing" },
    ];
    for (const scripts of cases) {
      const r = cloudflareBuildScript(scripts, run);
      expect(r.script).toBeNull();
      expect(r.warnings[0]).toContain("couldn't find `next build`");
    }
  });

  it("reports steps after next build inside a called script", () => {
    const r = cloudflareBuildScript({ build: "run-s next sitemap", next: "next build", sitemap: "next-sitemap" }, run);
    expect(r.script).toBeNull();
    expect(r.warnings[0]).toContain("(`npm run sitemap`)");
  });
});
