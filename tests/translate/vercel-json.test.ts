import { describe, expect, it } from "vitest";
import { translateVercelJson } from "../../src/translate/vercel-json.ts";

describe("translateVercelJson", () => {
  it("returns nothing for a missing file", () => {
    expect(translateVercelJson(null)).toEqual({ crons: [], manual: [] });
  });

  it("reports a file it can't parse", () => {
    const t = translateVercelJson("{ nope");
    expect(t.crons).toEqual([]);
    expect(t.manual[0]).toContain("couldn't be parsed");
  });

  it("keeps valid crons and reports invalid ones", () => {
    const t = translateVercelJson(
      JSON.stringify({
        crons: [
          { path: "/api/cron", schedule: "0 5 * * *" },
          { path: "api/no-slash", schedule: "0 5 * * *" },
          { path: "/api/x", schedule: "every day" },
        ],
      }),
    );
    expect(t.crons).toEqual([{ path: "/api/cron", schedule: "0 5 * * *" }]);
    expect(t.manual).toHaveLength(2);
  });

  it("points redirects, rewrites and headers at next.config.js", () => {
    const t = translateVercelJson(
      JSON.stringify({
        redirects: [{ source: "/a", destination: "/b" }],
        rewrites: [{ source: "/c", destination: "/d" }, { source: "/e", destination: "/f" }],
        headers: [{ source: "/(.*)", headers: [{ key: "X", value: "1" }] }],
      }),
    );
    expect(t.manual).toEqual([
      "1 redirect in vercel.json – add it to `redirects()` in next.config.js.",
      "2 rewrites in vercel.json – add them to `rewrites()` in next.config.js.",
      "1 header rule in vercel.json – add it to `headers()` in next.config.js.",
    ]);
  });

  it("explains settings that have no Workers equivalent and ignores $schema", () => {
    const t = translateVercelJson(JSON.stringify({ $schema: "x", functions: {}, regions: ["iad1"], somethingNew: 1 }));
    expect(t.manual).toEqual([
      "`functions` (memory and duration limits) has no direct equivalent – Workers limits are set per plan and in `limits` in cloudflare.config.ts.",
      "`regions` has no direct equivalent – Workers run in every Cloudflare location. Smart Placement is the closest option.",
      "`somethingNew` in vercel.json isn't translated.",
    ]);
  });
});
