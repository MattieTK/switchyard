import { describe, expect, it } from "vitest";
import { describeListenError } from "../../src/server/listen-error.ts";

describe("describeListenError", () => {
  it("explains why port 4417 specifically is needed", () => {
    const msg = describeListenError(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }), 4417);
    expect(msg).toContain("Port 4417 is already in use");
    expect(msg).toContain("Cloudflare login");
    expect(msg).toContain("lsof -i :4417");
  });

  it("passes other errors through", () => {
    expect(describeListenError(Object.assign(new Error("boom"), { code: "EACCES" }), 4417)).toContain("boom");
  });
});
