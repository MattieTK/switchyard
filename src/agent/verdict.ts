import type { Verdict } from "./types.ts";

// The line every agent is asked to end with. Agents add markdown or change the dash, so the
// match is loose: optional emphasis, any case, and a hyphen, en dash or em dash before the summary.
const VERDICT_LINE = /^[\s*_`>]*switchyard:\s*(fixed|cannot fix)\b\s*(?:[-–—:]\s*(.*?))?[\s*_`]*$/i;

export function parseVerdict(text: string): { verdict: Verdict; summary: string; message: string } {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i]?.match(VERDICT_LINE);
    if (!match) continue;
    const message = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").trim();
    return {
      verdict: match[1]?.toLowerCase() === "fixed" ? "fixed" : "cannot-fix",
      summary: (match[2] ?? "").trim(),
      message,
    };
  }
  return { verdict: "no-verdict", summary: "", message: text.trim() };
}
