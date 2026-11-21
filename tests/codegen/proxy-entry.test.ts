import { describe, expect, it } from "vitest";
import { proxyEntrySource, proxyRunWorkerFirst } from "../../src/codegen/proxy-entry.ts";

describe("proxyEntrySource", () => {
  it("computes runWorkerFirst patterns and generates a Worker entrypoint forwarding matched routes", () => {
    const proxies = [
      { prefix: "/api", target: "https://api.example.com/v1", wildcard: true },
      { prefix: "/health", target: "https://status.example.com/ok", wildcard: false },
    ];
    expect(proxyRunWorkerFirst(proxies)).toEqual(["/api/*", "/health"]);
    const code = proxyEntrySource(proxies);
    expect(code).toContain("https://api.example.com/v1");
    expect(code).toContain("env.ASSETS.fetch(request)");
    expect(code).toContain('headers.delete("host")');
  });
});
