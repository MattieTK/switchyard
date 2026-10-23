import { describe, expect, it } from "vitest";
import { planFlaggedUpdates } from "../../src/adapters/flagged-packages.ts";

const react19 = [{ name: "react", range: "^16.8 || ^17 || ^18", found: "19.3.1" }];

describe("planFlaggedUpdates", () => {
  it("updates a direct dependency whose latest release supports the new React", () => {
    const r = planFlaggedUpdates(
      [{ name: "framer-motion", version: "7.3.5", peers: react19 }],
      { "framer-motion": "^7.3.5" },
      new Map([["framer-motion", { version: "12.4.0", peerDependencies: { react: "^18.0.0 || ^19.0.0" } }]]),
    );
    expect(r.updates).toEqual([{ name: "framer-motion", from: "7.3.5", to: "^12.4.0" }]);
    expect(r.warnings).toEqual([
      "Switchyard updated framer-motion from 7.3.5 to ^12.4.0, the latest release, because 7.3.5 doesn't support react 19.3.1. A major update can change its API, so check its changelog.",
    ]);
  });

  it("counts a peer the latest release no longer declares as supported", () => {
    const r = planFlaggedUpdates(
      [{ name: "ai", version: "2.2.1", peers: react19 }],
      { ai: "2.2.1" },
      new Map([["ai", { version: "5.0.0" }]]),
    );
    expect(r.updates).toEqual([{ name: "ai", from: "2.2.1", to: "^5.0.0" }]);
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
        ["recharts", { version: "2.15.0", peerDependencies: { react: "^16.0.0 || ^17.0.0 || ^18.0.0" } }],
        ["private-lib", null],
      ]),
    );
    expect(r.updates).toEqual([]);
    expect(r.warnings).toEqual([
      expect.stringContaining("Its latest release, 2.15.0, doesn't declare support for react 19.3.1 either"),
      expect.stringContaining("it comes from another package rather than package.json"),
      expect.stringContaining("couldn't look up its latest release"),
    ]);
  });
});
