import { describe, expect, it } from "vitest";
import { approveBuilds, raiseNodeVersion, undecidedBuilds } from "../../src/codegen/toolchain-files.ts";

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
