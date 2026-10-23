import { describe, expect, it } from "vitest";
import { planFlaggedUpdates } from "../../src/adapters/flagged-packages.ts";

const react19 = [{ name: "react", range: "^16.8 || ^17 || ^18", found: "19.3.1" }];
const react = (range: string) => ({ react: range });

describe("planFlaggedUpdates", () => {
  it("updates a direct dependency to its first stable release that supports the new React", () => {
    const r = planFlaggedUpdates(
      [{ name: "framer-motion", version: "7.3.5", peers: react19 }],
      { "framer-motion": "^7.3.5" },
      new Map([
        [
          "framer-motion",
          [
            { version: "14.6.0", peerDependencies: react("^18.0.0 || ^19.0.0") },
            { version: "11.13.5", peerDependencies: react("^18.0.0 || ^19.0.0") },
            { version: "11.0.0-beta.1", peerDependencies: react("^19.0.0") },
            { version: "10.18.0", peerDependencies: react("^18.0.0") },
          ],
        ],
      ]),
    );
    expect(r.updates).toEqual([{ name: "framer-motion", from: "7.3.5", to: "^11.13.5" }]);
    expect(r.warnings).toEqual([
      "Switchyard updated framer-motion from 7.3.5 to ^11.13.5, the first release that supports react 19.3.1. It's a major update, which can change its API, so check its changelog.",
    ]);
  });

  it("counts a peer a release no longer declares as supported, and says nothing about a minor update", () => {
    const r = planFlaggedUpdates(
      [{ name: "lib", version: "2.2.1", peers: react19 }],
      { lib: "2.2.1" },
      new Map([["lib", [{ version: "2.3.0" }]]]),
    );
    expect(r.updates).toEqual([{ name: "lib", from: "2.2.1", to: "^2.3.0" }]);
    expect(r.warnings).toEqual(["Switchyard updated lib from 2.2.1 to ^2.3.0, the first release that supports react 19.3.1."]);
  });

  it("leaves packages it can't or shouldn't update, and says why", () => {
    const r = planFlaggedUpdates(
      [
        { name: "recharts", version: "2.1.14", peers: react19 },
        { name: "nested-lib", version: "1.0.0", peers: react19 },
        { name: "private-lib", version: "3.0.0", peers: react19 },
      ],
      { recharts: "^2.1.14", "private-lib": "3.0.0" },
      new Map([
        ["recharts", [{ version: "2.15.0", peerDependencies: react("^16.0.0 || ^17.0.0 || ^18.0.0") }]],
        ["private-lib", null],
      ]),
    );
    expect(r.updates).toEqual([]);
    expect(r.warnings).toEqual([
      expect.stringContaining("No newer release declares support for react 19.3.1 either"),
      expect.stringContaining("it comes from another package rather than package.json"),
      expect.stringContaining("couldn't look up its releases"),
    ]);
  });
});
