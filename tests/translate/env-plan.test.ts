import { describe, expect, it } from "vitest";
import type { VercelEnvVar } from "../../src/clients/vercel.ts";
import {
  buildEnvPlan,
  devVarsFile,
  missingInputs,
  runtimeSecrets,
  secretKeys,
  skipEntries,
  triggerVariables,
} from "../../src/translate/env-plan.ts";

const v = (over: Partial<VercelEnvVar>): VercelEnvVar => ({
  id: over.key ?? "id",
  key: "KEY",
  type: "encrypted",
  target: ["production"],
  value: "value",
  ...over,
});

const RESERVED = ["ASSETS", "IMAGES", "VINEXT_KV_CACHE"];

describe("buildEnvPlan", () => {
  it("sends production values to the production trigger and runtime secrets", () => {
    const { plan } = buildEnvPlan([v({ id: "1", key: "API_KEY" })], RESERVED);
    expect(plan.entries[0]).toMatchObject({
      key: "API_KEY",
      destinations: ["production-build", "runtime-secret"],
      isSecret: true,
      needsInput: false,
    });
  });

  it("sends preview values to the preview trigger and development values to .dev.vars", () => {
    const { plan } = buildEnvPlan(
      [v({ id: "1", key: "A", target: ["preview", "development"], type: "plain" })],
      RESERVED,
    );
    expect(plan.entries[0]?.destinations).toEqual(["preview-build", "dev-vars"]);
    expect(plan.entries[0]?.isSecret).toBe(false);
  });

  it("keeps values out of the plan", () => {
    const { plan, values } = buildEnvPlan([v({ id: "1", key: "A", value: "hunter22" })], RESERVED);
    expect(JSON.stringify(plan)).not.toContain("hunter22");
    expect(values).toEqual({ "1": "hunter22" });
  });

  it("asks for Sensitive values without a warning", () => {
    const { plan } = buildEnvPlan([v({ id: "1", key: "S", type: "sensitive", value: undefined })], RESERVED);
    expect(plan.entries[0]).toMatchObject({ needsInput: true, hasValue: false });
    expect(plan.warnings).toEqual([]);
  });

  it("asks for, and warns about, non-Sensitive values Vercel didn't return", () => {
    const { plan } = buildEnvPlan([v({ id: "1", key: "E", type: "encrypted", value: undefined })], RESERVED);
    expect(plan.entries[0]?.needsInput).toBe(true);
    expect(plan.warnings[0]).toContain("E");
  });

  it("skips system variables, branch-specific previews, reserved names and invalid names", () => {
    const { plan } = buildEnvPlan(
      [
        v({ id: "1", key: "VERCEL_URL", type: "system" }),
        v({ id: "2", key: "B", target: ["preview"], gitBranch: "feature-x" }),
        v({ id: "3", key: "ASSETS" }),
        v({ id: "4", key: "my-key" }),
      ],
      RESERVED,
    );
    expect(plan.entries.map((e) => [e.key, Boolean(e.skipReason), e.destinations])).toEqual([
      ["VERCEL_URL", true, []],
      ["B", true, []],
      ["ASSETS", true, []],
      ["my-key", true, []],
    ]);
    expect(plan.entries.every((e) => !e.needsInput)).toBe(true);
  });
});

describe("plan helpers", () => {
  const vars = [
    v({ id: "p", key: "API_KEY", value: "prod-secret" }),
    v({ id: "pv", key: "API_KEY", target: ["preview"], value: "preview-secret" }),
    v({ id: "pub", key: "NEXT_PUBLIC_URL", type: "plain", target: ["production", "preview"], value: "https://x" }),
    v({ id: "d", key: "LOCAL", type: "plain", target: ["development"], value: 'a "quoted"\nvalue' }),
    v({ id: "s", key: "SENSITIVE", type: "sensitive", value: undefined }),
  ];

  it("lists entries still missing a value", () => {
    const { plan, values } = buildEnvPlan(vars, RESERVED);
    expect(missingInputs(plan, values).map((e) => e.key)).toEqual(["SENSITIVE"]);
    expect(missingInputs(plan, { ...values, s: "typed" })).toEqual([]);
  });

  it("removes skipped entries from every destination", () => {
    const { plan, values } = buildEnvPlan(vars, RESERVED);
    const skipped = skipEntries(plan, ["s"]);
    expect(missingInputs(skipped, values)).toEqual([]);
    expect(Object.keys(runtimeSecrets(skipped, values))).not.toContain("SENSITIVE");
  });

  it("builds trigger variables per environment, marking secrets", () => {
    const { plan, values } = buildEnvPlan(vars, RESERVED);
    expect(triggerVariables(plan, { ...values, s: "typed" }, "production")).toEqual({
      API_KEY: { value: "prod-secret", is_secret: true },
      NEXT_PUBLIC_URL: { value: "https://x", is_secret: false },
      SENSITIVE: { value: "typed", is_secret: true },
    });
    expect(triggerVariables(plan, values, "preview")).toEqual({
      API_KEY: { value: "preview-secret", is_secret: true },
      NEXT_PUBLIC_URL: { value: "https://x", is_secret: false },
    });
  });

  it("builds runtime secrets from production values only", () => {
    const { plan, values } = buildEnvPlan(vars, RESERVED);
    expect(runtimeSecrets(plan, values)).toEqual({ API_KEY: "prod-secret", NEXT_PUBLIC_URL: "https://x" });
    expect(secretKeys(plan)).toEqual(["API_KEY", "NEXT_PUBLIC_URL", "SENSITIVE"]);
  });

  it("writes development values as an escaped .dev.vars file", () => {
    const { plan, values } = buildEnvPlan(vars, RESERVED);
    expect(devVarsFile(plan, values)).toBe('LOCAL="a \\"quoted\\"\\nvalue"\n');
  });
});
