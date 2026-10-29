import { describe, expect, it } from "vitest";
import { hasSpaFallback, isSpaFallback, translateVercelJson, vercelJsonBuildSettings } from "../../src/translate/vercel-json.ts";

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

  it.each([
    ["null", "null"],
    ["an array", "[1]"],
    ["a string", '"abc"'],
    ["a number", "5"],
  ])("reports valid JSON that is %s, not an object, without throwing", (_label, raw) => {
    expect(translateVercelJson(raw)).toEqual({
      crons: [],
      manual: ["vercel.json isn't a JSON object, so nothing in it was translated."],
    });
  });

  it("reports a null cron entry as invalid without throwing", () => {
    const t = translateVercelJson(JSON.stringify({ crons: [null] }));
    expect(t.crons).toEqual([]);
    expect(t.manual).toEqual(["Cron job null in vercel.json isn't valid, so it wasn't translated."]);
  });

  it("does not read inherited object properties as settings", () => {
    const t = translateVercelJson('{"constructor":1,"__proto__":1}');
    expect(t.manual).toEqual(["`constructor` in vercel.json isn't translated.", "`__proto__` in vercel.json isn't translated."]);
    expect(t.manual.every((m) => typeof m === "string")).toBe(true);
  });

  describe("day-of-week translation", () => {
    const cronAt = (schedule: string) => translateVercelJson(JSON.stringify({ crons: [{ path: "/api/x", schedule }] }));

    it.each([
      ["0 5 * * 1", "0 5 * * MON"],
      ["0 0 * * 0", "0 0 * * SUN"],
      ["0 0 * * 7", "0 0 * * SUN"],
      ["0 9 * * 1-5", "0 9 * * MON-FRI"],
      ["0 0 * * 1,3,5", "0 0 * * MON,WED,FRI"],
      ["*/15 * * * *", "*/15 * * * *"],
      ["0 0 * * */2", "0 0 * * */2"],
      ["0 0 * * 1-5/2", "0 0 * * MON-FRI/2"],
      ["0 0 * * mon-fri", "0 0 * * MON-FRI"],
    ])("translates %s to %s", (input, expected) => {
      expect(cronAt(input)).toEqual({ crons: [{ path: "/api/x", schedule: expected }], manual: [] });
    });

    it.each(["0 0 * * 9", "0 0 * * 1-7", "0 0 * * 0-7", "0 0 * * 5-1", "0 0 * * 1,,3", "0 0 * * */0", "0 0 * * funday"])(
      "reports %s as invalid",
      (input) => {
        const t = cronAt(input);
        expect(t.crons).toEqual([]);
        expect(t.manual).toHaveLength(1);
        expect(t.manual[0]).toContain("isn't valid");
      },
    );
  });

  describe("for apps Next.js doesn't serve", () => {
    const assets = { nextjs: false };

    it("points routing rules at Workers static assets and skips the single-page fallback", () => {
      const t = translateVercelJson(
        JSON.stringify({
          redirects: [{ source: "/a", destination: "/b" }],
          headers: [{ source: "/(.*)", headers: [] }, { source: "/x", headers: [] }],
          rewrites: [{ source: "/(.*)", destination: "/index.html" }],
          cleanUrls: true,
          trailingSlash: false,
        }),
        assets,
      );
      expect(t.manual).toEqual([
        "1 redirect in vercel.json – recreate it in a `_redirects` file in the site's output folder, or in the app.",
        "2 header rules in vercel.json – recreate them in a `_headers` file in the site's output folder.",
        expect.stringContaining("`trailingSlash` isn't translated"),
      ]);
    });

    it("still lists rewrites other than the fallback", () => {
      const t = translateVercelJson(
        JSON.stringify({ rewrites: [{ source: "/:path*", destination: "/" }, { source: "/api/:p", destination: "https://api.example.com/:p" }] }),
        assets,
      );
      expect(t.manual).toEqual([expect.stringContaining("1 rewrite in vercel.json – recreate it in the app")]);
    });
  });

  it("recognises catch-all rewrites to index.html", () => {
    expect(isSpaFallback({ source: "/(.*)", destination: "/index.html" })).toBe(true);
    expect(isSpaFallback({ source: "/:path*", destination: "/" })).toBe(true);
    expect(isSpaFallback({ source: "/blog/(.*)", destination: "/index.html" })).toBe(false);
    expect(isSpaFallback({ source: "/(.*)", destination: "/index.html", has: [{ type: "host", value: "x" }] })).toBe(false);
    expect(isSpaFallback(null)).toBe(false);
    expect(hasSpaFallback('{"rewrites":[{"source":"/(.*)","destination":"/index.html"}]}')).toBe(true);
    expect(hasSpaFallback("{nope")).toBe(false);
    expect(hasSpaFallback(null)).toBe(false);
  });

  it("reads the build settings vercel.json overrides", () => {
    expect(vercelJsonBuildSettings('{"buildCommand":"npm run docs","outputDirectory":"site","framework":null,"cleanUrls":true}')).toEqual({
      framework: null,
      buildCommand: "npm run docs",
      outputDirectory: "site",
    });
    expect(vercelJsonBuildSettings('{"buildCommand":3}')).toEqual({});
    expect(vercelJsonBuildSettings(null)).toEqual({});
    expect(vercelJsonBuildSettings("[")).toEqual({});
  });

  it("doesn't list build settings the converter follows", () => {
    const raw = '{"buildCommand":"npm run docs","outputDirectory":"site"}';
    expect(translateVercelJson(raw, { nextjs: false, buildSettings: true }).manual).toEqual([]);
    expect(translateVercelJson(raw, { nextjs: false }).manual).toHaveLength(2);
  });
});
