import { isAbsolute, relative } from "node:path";

// Helpers shared by the drivers for turning agent events into log lines.

const MAX_LINE = 300;

export function shorten(text: string, max = MAX_LINE): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// Paths inside the project are shown relative to it; others are left as they are.
export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

// An agent's message as log lines, one per non-empty line.
export function messageLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `Agent: ${shorten(l)}`);
}

export function parseJsonLine(line: string): unknown {
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
