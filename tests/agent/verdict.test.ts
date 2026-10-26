import { describe, expect, it } from "vitest";
import { parseVerdict } from "../../src/agent/verdict.ts";

describe("parseVerdict", () => {
  it("reads a fixed verdict and its summary", () => {
    expect(parseVerdict("Changed the import.\n\nSWITCHYARD: fixed – pointed build.js at lib/greet.js")).toEqual({
      verdict: "fixed",
      summary: "pointed build.js at lib/greet.js",
      message: "Changed the import.",
    });
  });

  it("accepts a hyphen or an em dash and no summary", () => {
    expect(parseVerdict("SWITCHYARD: cannot fix - needs a Supabase key").summary).toBe("needs a Supabase key");
    expect(parseVerdict("SWITCHYARD: cannot fix — needs a key").verdict).toBe("cannot-fix");
    expect(parseVerdict("done\nSWITCHYARD: fixed")).toEqual({ verdict: "fixed", summary: "", message: "done" });
  });

  it("finds the last verdict line even with text after it, and ignores case and markdown around it", () => {
    const text = "SWITCHYARD: cannot fix – first thought\nthen I tried again\n**switchyard: Fixed – second try**\nThanks!";
    expect(parseVerdict(text)).toEqual({
      verdict: "fixed",
      summary: "second try",
      message: "SWITCHYARD: cannot fix – first thought\nthen I tried again\nThanks!",
    });
  });

  it("reports no verdict when the line is missing", () => {
    expect(parseVerdict("I changed vite.config.ts.")).toEqual({
      verdict: "no-verdict",
      summary: "",
      message: "I changed vite.config.ts.",
    });
  });
});
