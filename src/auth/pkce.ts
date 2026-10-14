import { createHash, randomBytes } from "node:crypto";

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
