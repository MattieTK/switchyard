import { describe, expect, it } from "vitest";
import { incompatibleDependencyWarnings } from "../../src/adapters/next-codemod-output.ts";

// As printed by @next/codemod 16.4.1, with colours stripped by the command runner.
const OUTPUT = `✔ Codemods have been applied successfully.
⚠ Found 2 dependencies that seem incompatible with the upgraded package versions.
You may have to update these packages to their latest version or file an issue to ask for support of the upgraded libraries.
react-twitter-widgets 1.9.5
  └── ✕ unmet peer react@"^16.8.0": found 19.3.1
@acme/ui 2.0.0
  ├── ✕ unmet peer react@"^17.0.0": found 19.3.1
  └── ✕ unmet peer @types/react@"^17": found 19.2.7

Please review the local changes and read the Next.js 16 migration guide to complete the migration.`;

describe("incompatibleDependencyWarnings", () => {
  it("turns each flagged package into a warning", () => {
    expect(incompatibleDependencyWarnings(OUTPUT)).toEqual([
      "react-twitter-widgets 1.9.5 supports react ^16.8.0, but the upgrade installed react 19.3.1. If the build or the app fails, update or replace it.",
      "@acme/ui 2.0.0 supports react ^17.0.0 and @types/react ^17, but the upgrade installed react 19.3.1 and @types/react 19.2.7. If the build or the app fails, update or replace it.",
    ]);
  });

  it("returns nothing when the upgrade found no incompatible packages", () => {
    expect(incompatibleDependencyWarnings("✔ Codemods have been applied successfully.\n")).toEqual([]);
  });
});
