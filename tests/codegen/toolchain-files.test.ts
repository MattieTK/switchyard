import { describe, expect, it } from "vitest";
import { raiseNodeVersion } from "../../src/codegen/toolchain-files.ts";

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
