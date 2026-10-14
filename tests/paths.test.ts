import { describe, expect, it } from "vitest";
import { resolvePaths } from "../src/paths.ts";

describe("resolvePaths", () => {
  it("uses ~/.config and ~/.cache by default", () => {
    const p = resolvePaths({}, "/home/u");
    expect(p.configDir).toBe("/home/u/.config/switchyard");
    expect(p.cacheDir).toBe("/home/u/.cache/switchyard");
    expect(p.credentialsFile).toBe("/home/u/.config/switchyard/credentials.json");
    expect(p.jobsDir).toBe("/home/u/.config/switchyard/jobs");
    expect(p.workDir).toBe("/home/u/.cache/switchyard/work");
  });

  it("respects XDG variables", () => {
    const p = resolvePaths({ XDG_CONFIG_HOME: "/x/c", XDG_CACHE_HOME: "/x/k" }, "/home/u");
    expect(p.configDir).toBe("/x/c/switchyard");
    expect(p.cacheDir).toBe("/x/k/switchyard");
  });

  it("puts everything under SWITCHYARD_HOME when set", () => {
    const p = resolvePaths({ SWITCHYARD_HOME: "/tmp/sy" }, "/home/u");
    expect(p.configDir).toBe("/tmp/sy/config");
    expect(p.cacheDir).toBe("/tmp/sy/cache");
  });
});
