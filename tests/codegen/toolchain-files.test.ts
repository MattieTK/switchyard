import { describe, expect, it } from "vitest";
import {
  approveBuilds,
  preapproveYarnPackages,
  quarantinedPackages,
  raiseNodeVersion,
  undecidedBuilds,
} from "../../src/codegen/toolchain-files.ts";

describe("raiseNodeVersion", () => {
  it("raises a pin older than Node.js 22 to 22", () => {
    expect(raiseNodeVersion("18\n")).toEqual({ from: "18", text: "22\n" });
    expect(raiseNodeVersion("v20.19.6")).toEqual({ from: "v20.19.6", text: "22\n" });
    expect(raiseNodeVersion("﻿20.11\r\n")).toEqual({ from: "20.11", text: "22\n" });
    expect(raiseNodeVersion("lts/iron")).toEqual({ from: "lts/iron", text: "22\n" });
  });

  it("leaves new enough and unrecognised pins alone", () => {
    expect(raiseNodeVersion("22.4.0\n")).toBeNull();
    expect(raiseNodeVersion("v24")).toBeNull();
    expect(raiseNodeVersion("lts/jod")).toBeNull();
    expect(raiseNodeVersion("lts/*")).toBeNull();
    expect(raiseNodeVersion("node")).toBeNull();
    expect(raiseNodeVersion("20chore: add Node.js version")).toBeNull();
    expect(raiseNodeVersion("")).toBeNull();
  });
});

describe("undecidedBuilds and approveBuilds", () => {
  const yaml = `strictDepBuilds: true

allowBuilds:
  esbuild: true
  workerd: set this to true or false
  'sharp': set this to true or false
  canvas: false
`;

  it("lists the packages waiting for a decision", () => {
    expect(undecidedBuilds(yaml)).toEqual(["workerd", "sharp"]);
    expect(undecidedBuilds("allowBuilds:\n  workerd: false\n")).toEqual([]);
  });

  it("approves only the named packages and keeps quoting", () => {
    expect(approveBuilds(yaml, ["workerd", "canvas"])).toBe(`strictDepBuilds: true

allowBuilds:
  esbuild: true
  workerd: true
  'sharp': set this to true or false
  canvas: false
`);
    expect(approveBuilds(yaml, ["sharp"])).toContain("  'sharp': true\n");
  });
});

describe("preapproveYarnPackages", () => {
  it("adds the setting when the file doesn't have it", () => {
    expect(preapproveYarnPackages('nodeLinker: "node-modules"\nnpmMinimalAgeGate: "3d"', ["vinext", "@cloudflare/*"])).toEqual({
      text: 'nodeLinker: "node-modules"\nnpmMinimalAgeGate: "3d"\n\nnpmPreapprovedPackages:\n  - "vinext"\n  - "@cloudflare/*"\n',
      added: ["vinext", "@cloudflare/*"],
    });
    expect(preapproveYarnPackages("", ["vinext"])?.text).toBe('npmPreapprovedPackages:\n  - "vinext"\n');
  });

  it("extends an existing list without repeating entries", () => {
    const yaml = 'npmPreapprovedPackages:\n  - "@acme/*"\n  - vinext\nnodeLinker: pnp\n';
    expect(preapproveYarnPackages(yaml, ["vinext", "vite"])).toEqual({
      text: 'npmPreapprovedPackages:\n  - "vite"\n  - "@acme/*"\n  - vinext\nnodeLinker: pnp\n',
      added: ["vite"],
    });
    expect(preapproveYarnPackages(yaml, ["vinext"])).toEqual({ text: yaml, added: [] });
    // Items of a later list don't count.
    const later = 'npmPreapprovedPackages:\n  - "@acme/*"\npackageExtensions:\n  - vite\n';
    expect(preapproveYarnPackages(later, ["vite"])?.added).toEqual(["vite"]);
  });

  it("leaves an inline list alone", () => {
    expect(preapproveYarnPackages('npmPreapprovedPackages: ["@acme/*"]\n', ["vinext"])).toBeNull();
  });
});

describe("quarantinedPackages", () => {
  it("names the packages Yarn held back for their release age", () => {
    const requested = `➤ YN0060: │ react is listed by your project with version 18.2.0 (p993930), which doesn't satisfy what react-server-dom-webpack requests.
➤ YN0027: @cloudflare/vite-plugin@beta can't be resolved to a satisfying range
➤ YN0016: All versions satisfying "^2.0.0-beta.v.4" are quarantined
`;
    expect(quarantinedPackages(requested)).toEqual(["@cloudflare/vite-plugin"]);
    const dependency = `➤ YN0000: ┌ Resolution step
➤ YN0016: │ miniflare@npm:5.20261019.1-beta: All versions satisfying "5.20261019.1-beta" are quarantined
➤ YN0016: │ @cloudflare/unenv-preset@npm:2.9.0: All versions satisfying "2.9.0" are quarantined
`;
    expect(quarantinedPackages(dependency)).toEqual(["miniflare", "@cloudflare/unenv-preset"]);
  });

  it("finds nothing in other failures", () => {
    expect(quarantinedPackages("➤ YN0027: left-pad@^9 can't be resolved to a satisfying range\n")).toEqual([]);
    expect(quarantinedPackages("ERESOLVE unable to resolve dependency tree")).toEqual([]);
  });
});
