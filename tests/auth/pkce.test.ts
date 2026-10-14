import { describe, expect, it } from "vitest";
import { challengeFor, createPkcePair, randomToken } from "../../src/auth/pkce.ts";

describe("pkce", () => {
  it("matches the RFC 7636 appendix B example", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates a verifier of at least 43 URL-safe characters with a matching challenge", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(challengeFor(verifier));
  });

  it("creates distinct random tokens", () => {
    expect(randomToken()).not.toBe(randomToken());
  });
});
