import { describe, expect, it } from "vitest";
import * as config from "../src/config.ts";

describe("config", () => {
  it("registers a redirect URI on the fixed port", () => {
    expect(config.CLOUDFLARE_REDIRECT_URI).toBe(`http://localhost:${config.PORT}/auth/cloudflare/callback`);
  });

  it("has a real client ID", () => {
    expect(config.CLOUDFLARE_CLIENT_ID).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  });

  it("uses dot-delimited scopes only (Cloudflare rejects colon-delimited ones)", () => {
    for (const s of config.CLOUDFLARE_SCOPES) expect(s).toMatch(/^[a-z0-9_-]+\.[a-z_]+$/);
  });

  it("never uses a common production branch name for the migration branch", () => {
    expect(["main", "master", "production"]).not.toContain(config.MIGRATION_BRANCH);
  });
});
