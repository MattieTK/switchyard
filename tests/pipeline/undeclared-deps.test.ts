import { describe, expect, it } from "vitest";
import { findUndeclaredImports, previousVersion } from "../../src/pipeline/undeclared-deps.ts";

const ROLLDOWN = `[vite]: Rolldown failed to resolve import "@babel/runtime/regenerator" from "/w/app/node_modules/react-twitter-widgets/es/index.js".
This is most likely unintended because it can break your application at runtime.
Error: [vite]: Rolldown failed to resolve import "@babel/runtime/regenerator" from "/w/app/node_modules/react-twitter-widgets/es/index.js".
Error: [vite]: Rollup failed to resolve import "tiny-warning" from "/w/app/node_modules/.pnpm/@acme+ui@2.0.0/node_modules/@acme/ui/dist/index.js".
Error: [vite]: Rolldown failed to resolve import "components/Header" from "/w/app/pages/index.js".
Error: [vite]: Rolldown failed to resolve import "./missing" from "/w/app/node_modules/lib/index.js".
Error: [vite]: Rolldown failed to resolve import "node:fs" from "/w/app/node_modules/lib/index.js".`;

describe("findUndeclaredImports", () => {
  it("finds bare imports from installed packages, once per package", () => {
    expect(findUndeclaredImports(ROLLDOWN)).toEqual([
      { packageName: "@babel/runtime", importer: "react-twitter-widgets" },
      { packageName: "tiny-warning", importer: "@acme/ui" },
    ]);
  });

  it("finds nothing in an unrelated failure", () => {
    expect(findUndeclaredImports("Type error: x is not assignable to y")).toEqual([]);
  });
});

describe("previousVersion", () => {
  it("reads Yarn 1 lockfiles", () => {
    const lock = `"@babel/runtime@7.12.5", "@babel/runtime@^7.8.4":
  version "7.12.5"
  resolved "https://registry.yarnpkg.com/@babel/runtime/-/runtime-7.12.5.tgz"

"@babel/runtime-corejs3@^7.10.2":
  version "7.13.0"
`;
    expect(previousVersion("yarn.lock", lock, "@babel/runtime")).toBe("7.12.5");
  });

  it("reads Yarn 2+ lockfiles", () => {
    const lock = `"tiny-warning@npm:^1.0.0":
  version: 1.0.3
  resolution: "tiny-warning@npm:1.0.3"
`;
    expect(previousVersion("yarn.lock", lock, "tiny-warning")).toBe("1.0.3");
  });

  it("reads npm lockfiles and picks the highest version", () => {
    const lock = JSON.stringify({
      packages: {
        "": {},
        "node_modules/@babel/runtime": { version: "7.12.5" },
        "node_modules/x/node_modules/@babel/runtime": { version: "7.20.1" },
        "node_modules/@babel/runtime-corejs3": { version: "7.30.0" },
      },
    });
    expect(previousVersion("package-lock.json", lock, "@babel/runtime")).toBe("7.20.1");
  });

  it("reads pnpm lockfiles in old and new formats", () => {
    expect(previousVersion("pnpm-lock.yaml", "packages:\n  /@babel/runtime/7.12.5:\n    resolution: {}\n", "@babel/runtime")).toBe("7.12.5");
    expect(previousVersion("pnpm-lock.yaml", "packages:\n  '@babel/runtime@7.24.0':\n    resolution: {}\n", "@babel/runtime")).toBe("7.24.0");
  });

  it("returns null when the package wasn't installed before", () => {
    expect(previousVersion("yarn.lock", `react@^17:\n  version "17.0.1"\n`, "@babel/runtime")).toBeNull();
    expect(previousVersion("package-lock.json", "not json", "@babel/runtime")).toBeNull();
  });
});
