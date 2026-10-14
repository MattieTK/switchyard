import { describe, expect, it } from "vitest";
import { createRedactor } from "../src/redact.ts";

describe("createRedactor", () => {
  it("replaces registered values", () => {
    const r = createRedactor();
    r.add("s3cret-value");
    expect(r.redact("token=s3cret-value; again s3cret-value")).toBe("token=***; again ***");
  });

  it("replaces longer values before their prefixes", () => {
    const r = createRedactor();
    r.add("abcd");
    r.add("abcdefgh");
    expect(r.redact("abcdefgh abcd")).toBe("*** ***");
  });

  it("ignores empty, undefined and very short values so logs stay readable", () => {
    const r = createRedactor();
    r.add(undefined);
    r.add("");
    r.add("abc");
    expect(r.redact("abc true 1")).toBe("abc true 1");
  });

  it("also replaces the JSON-escaped form of a value", () => {
    const r = createRedactor();
    r.add('pa"ss\nword');
    expect(r.redact(JSON.stringify({ v: 'pa"ss\nword' }))).toBe('{"v":"***"}');
  });

  it("returns text unchanged when nothing is registered", () => {
    expect(createRedactor().redact("hello")).toBe("hello");
  });
});
