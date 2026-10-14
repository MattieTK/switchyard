import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePackageManager } from "../src/toolchain.ts";
import { fakeRunner } from "./helpers/fake-runner.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const notFound = () => {
  throw new Error("Couldn't start yarn (EACCES). Check it's installed and on PATH.");
};

describe("ensurePackageManager", () => {
  let binDir: string;
  beforeEach(async () => {
    binDir = join(await makeTempDir(), "bin");
  });
  afterEach(async () => {
    await rm(join(binDir, ".."), { recursive: true, force: true });
  });

  it("does nothing for npm, which comes with Node", async () => {
    const { run, calls } = fakeRunner();
    await ensurePackageManager({ pm: "npm", cwd: "/w", run, binDir, log: () => {} });
    expect(calls).toEqual([]);
  });

  it("uses an installed package manager as it is", async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0, output: "1.22.22\n" }));
    await ensurePackageManager({ pm: "yarn", cwd: "/w", run, binDir, log: () => {} });
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([["yarn", "--version"]]);
    expect(calls[0]?.opts?.cwd).toBe("/w");
  });

  it("sets up a missing yarn or pnpm through corepack in Switchyard's own folder", async () => {
    let installed = false;
    const { run, calls } = fakeRunner((cmd) => {
      if (cmd === "corepack") {
        installed = true;
        return { code: 0, output: "" };
      }
      return installed ? { code: 0, output: "10.0.0\n" } : notFound();
    });
    const logs: string[] = [];
    await ensurePackageManager({ pm: "pnpm", cwd: "/w", run, binDir, log: (l) => logs.push(l) });
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["pnpm", "--version"],
      ["corepack", "enable", "--install-directory", binDir, "pnpm"],
      ["pnpm", "--version"],
    ]);
    expect(await readdir(binDir)).toEqual([]);
    expect(logs).toEqual(["pnpm isn't installed, so Switchyard set it up through corepack (version 10.0.0)."]);
  });

  it("explains how to install yarn when corepack can't provide it", async () => {
    const { run } = fakeRunner((cmd) => (cmd === "corepack" ? { code: 1, output: "nope" } : notFound()));
    await expect(ensurePackageManager({ pm: "yarn", cwd: "/w", run, binDir, log: () => {} })).rejects.toThrow(
      "This project uses yarn, which isn't installed on this computer, and Switchyard couldn't set it up through corepack. Install it with `npm install -g yarn`, then retry.",
    );
  });

  it("explains how to install bun without trying corepack", async () => {
    const { run, calls } = fakeRunner(notFound);
    await expect(ensurePackageManager({ pm: "bun", cwd: "/w", run, binDir, log: () => {} })).rejects.toThrow(
      "This project uses bun, which isn't installed on this computer. Install it from https://bun.sh, then retry.",
    );
    expect(calls.map((c) => c.cmd)).toEqual(["bun"]);
  });
});
