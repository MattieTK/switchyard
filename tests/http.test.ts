import { describe, expect, it } from "vitest";
import { ApiError, createJsonClient, isAuthError } from "../src/http.ts";
import { fakeFetch, json } from "./helpers/fake-fetch.ts";

function client(responses: Parameters<typeof fakeFetch>[0], sleeps: number[] = []) {
  const f = fakeFetch(responses);
  const c = createJsonClient({
    service: "cloudflare",
    baseUrl: "https://api.example.com/v4",
    fetch: f.fetch,
    token: async () => "tok-123",
    errorMessage: (b) => (b as { message?: string })?.message,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { c, calls: f.calls };
}

describe("createJsonClient", () => {
  it("sends bearer auth, query and JSON body, and parses the response", async () => {
    const { c, calls } = client([json({ ok: 1 })]);
    const res = await c.request<{ ok: number }>("/things", {
      method: "POST",
      query: { a: "1", skip: undefined, n: 2 },
      body: { x: true },
    });
    expect(res).toEqual({ ok: 1 });
    expect(calls[0]?.url).toBe("https://api.example.com/v4/things?a=1&n=2");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.init?.body).toBe('{"x":true}');
  });

  it("retries 429 using Retry-After, then succeeds", async () => {
    const sleeps: number[] = [];
    const { c } = client([json({}, 429, { "retry-after": "2" }), json({ ok: true })], sleeps);
    expect(await c.request("/x")).toEqual({ ok: true });
    expect(sleeps).toEqual([2000]);
  });

  it("retries 5xx with exponential backoff and gives up after three retries", async () => {
    const sleeps: number[] = [];
    const { c, calls } = client(
      [json({ message: "a" }, 503), json({}, 503), json({}, 503), json({ message: "down" }, 503)],
      sleeps,
    );
    await expect(c.request("/x")).rejects.toThrow("cloudflare API error 503: down");
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it("does not retry other 4xx responses", async () => {
    const { c, calls } = client([json({ message: "bad input" }, 400)]);
    const err = await c.request("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect(isAuthError(err)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("marks 401 as an auth error", async () => {
    const { c } = client([json({ message: "expired" }, 401)]);
    const err = await c.request("/x").catch((e: unknown) => e);
    expect(isAuthError(err)).toBe(true);
  });

  it("uses isAuthFailure for service-specific auth responses", async () => {
    const f = fakeFetch([json({ error: { invalidToken: true } }, 403)]);
    const c = createJsonClient({
      service: "vercel",
      baseUrl: "https://api.vercel.com",
      fetch: f.fetch,
      token: async () => "t",
      errorMessage: () => "Not authorized",
      isAuthFailure: (status, body) =>
        status === 403 && (body as { error?: { invalidToken?: boolean } }).error?.invalidToken === true,
    });
    expect(isAuthError(await c.request("/x").catch((e: unknown) => e))).toBe(true);
  });

  it("returns null for 404 when allow404 is set", async () => {
    const { c } = client([json({ message: "nope" }, 404)]);
    expect(await c.request("/x", { allow404: true })).toBeNull();
  });

  it("returns undefined for 204", async () => {
    const { c } = client([new Response(null, { status: 204 })]);
    expect(await c.request("/x", { method: "DELETE" })).toBeUndefined();
  });

  it("falls back to the status text when the error body is not JSON", async () => {
    const { c } = client([new Response("<html>oops</html>", { status: 400, statusText: "Bad Request" })]);
    await expect(c.request("/x")).rejects.toThrow("cloudflare API error 400: Bad Request");
  });
});
