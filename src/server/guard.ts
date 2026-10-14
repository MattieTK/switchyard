import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

// Blocks DNS rebinding: a page on another domain that resolves to 127.0.0.1
// still sends its own hostname in the Host header.
export function hostGuard(port: number): MiddlewareHandler {
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  return async (c, next) => {
    if (!allowed.has(c.req.header("host") ?? "")) return c.text("Forbidden: unexpected Host header", 403);
    await next();
  };
}

// Stops other pages in the browser from calling the API: only the tab opened
// from the terminal link knows the per-launch token.
export function tokenGuard(token: string): MiddlewareHandler {
  const expected = Buffer.from(token);
  return async (c, next) => {
    const given = Buffer.from(c.req.header("x-switchyard-token") || c.req.query("t") || "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return c.json({ error: "Missing or wrong launch token. Open Switchyard from the link printed in the terminal." }, 401);
    }
    await next();
  };
}
