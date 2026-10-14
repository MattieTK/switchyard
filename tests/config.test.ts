import { describe, expect, it } from "vitest";
import * as config from "../src/config.ts";

describe("config", () => {
  it("registers a redirect URI on the fixed port", () => {
    expect(config.CLOUDFLARE_REDIRECT_URI).toBe(`http://localhost:${config.PORT}/auth/cloudflare/callback`);
  });

  it("has a real client ID", () => {
    expect(config.CLOUDFLARE_CLIENT_ID).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  });

  it("uses dot-delimited API scopes (Cloudflare rejects colon-delimited ones) plus offline_access", () => {
    for (const s of config.CLOUDFLARE_SCOPES) {
      if (s !== "offline_access") expect(s).toMatch(/^[a-z0-9_-]+\.[a-z_]+$/);
    }
  });

  it("requests a refresh token and Workers script write access", () => {
    expect(config.CLOUDFLARE_SCOPES).toContain("offline_access");
    expect(config.CLOUDFLARE_SCOPES).toContain("workers-scripts.write");
  });

  it("never uses a common production branch name for the migration branch", () => {
    expect(["main", "master", "production"]).not.toContain(config.MIGRATION_BRANCH);
  });
});
