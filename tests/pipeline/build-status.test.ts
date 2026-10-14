import { describe, expect, it } from "vitest";
import { interpretBuild } from "../../src/pipeline/build-status.ts";

describe("interpretBuild", () => {
  it("uses build_outcome when present", () => {
    expect(interpretBuild({ build_uuid: "b", status: "stopped", build_outcome: "success" })).toBe("success");
    expect(interpretBuild({ build_uuid: "b", status: "stopped", build_outcome: "fail" })).toBe("failure");
  });

  it("falls back to the status", () => {
    expect(interpretBuild({ build_uuid: "b", status: "running", build_outcome: null })).toBe("running");
    expect(interpretBuild({ build_uuid: "b", status: "queued" })).toBe("running");
    expect(interpretBuild({ build_uuid: "b", status: "stopped" })).toBe("failure");
  });
});
