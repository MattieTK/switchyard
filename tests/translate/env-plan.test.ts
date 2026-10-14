import dotenv from "dotenv";
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
  decrypted: true,
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

  it("treats an encrypted variable that Vercel did not decrypt as needing input", () => {
    const { plan, values } = buildEnvPlan(
      [v({ id: "1", key: "E", value: "Y2lwaGVydGV4dA==", decrypted: false })],
      RESERVED,
    );
    expect(plan.entries[0]).toMatchObject({ hasValue: false, needsInput: true });
    expect(plan.warnings[0]).toContain("E");
    expect(values).toEqual({});
  });

  it("uses a plain variable's value without a decrypted flag", () => {
    const { plan, values } = buildEnvPlan([v({ id: "1", key: "P", type: "plain", value: "x", decrypted: undefined })], RESERVED);
    expect(plan.entries[0]).toMatchObject({ hasValue: true, needsInput: false });
    expect(values).toEqual({ "1": "x" });
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

  it("writes development values as a .dev.vars file dotenv reads back exactly", () => {
    const { plan, values } = buildEnvPlan(vars, RESERVED);
    expect(dotenv.parse(devVarsFile(plan, values))).toEqual({ LOCAL: 'a "quoted"\nvalue' });
  });
});

describe("devVarsFile", () => {
  const readBack = (value: string) => {
    const { plan, values } = buildEnvPlan(
      [v({ id: "d", key: "LOCAL", type: "plain", target: ["development"], value })],
      RESERVED,
    );
    return dotenv.parse(devVarsFile(plan, values)).LOCAL;
  };

  it("round-trips a value containing double quotes", () => {
    expect(readBack('say "hi"')).toBe('say "hi"');
  });

  it("round-trips a Windows path without changing its backslashes", () => {
    expect(readBack("C:\\Users\\tk\\new")).toBe("C:\\Users\\tk\\new");
    expect(readBack("C:\\Users\\tk\\")).toBe("C:\\Users\\tk\\");
  });

  it("round-trips a multi-line value", () => {
    expect(readBack("line one\nline two")).toBe("line one\nline two");
  });

  it("round-trips a value containing a single quote", () => {
    expect(readBack("it's fine")).toBe("it's fine");
  });

  it("round-trips a plain value", () => {
    expect(readBack("plain-value")).toBe("plain-value");
  });

  it("round-trips a value whose only line break is a carriage return", () => {
    expect(readBack("first\rsecond")).toBe("first\rsecond");
  });

  it("writes a comment, not a line, for a value containing every quote character", () => {
    const { plan, values } = buildEnvPlan(
      [v({ id: "d", key: "LOCAL", type: "plain", target: ["development"], value: `it's \`x\` "y"` })],
      RESERVED,
    );
    expect(devVarsFile(plan, values)).toBe(
      "# LOCAL not written: the value contains every quote character dotenv supports\n",
    );
    expect(dotenv.parse(devVarsFile(plan, values))).toEqual({});
  });

  it("writes a comment for a value dotenv would read a line break from", () => {
    const { plan, values } = buildEnvPlan(
      [v({ id: "d", key: "LOCAL", type: "plain", target: ["development"], value: "it's `x`\\nb" })],
      RESERVED,
    );
    expect(devVarsFile(plan, values)).toBe(
      "# LOCAL not written: no quoting style this file uses reads the value back exactly\n",
    );
    expect(dotenv.parse(devVarsFile(plan, values))).toEqual({});
  });
});
