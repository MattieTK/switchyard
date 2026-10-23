// Edits to project files that Cloudflare's build tools need, both locally and in Workers Builds.

// cf needs Node.js 22 or later, and Workers Builds reads .nvmrc and .node-version.
export const MIN_NODE_MAJOR = 22;
export const NODE_VERSION_FILES = [".nvmrc", ".node-version"] as const;

// nvm's names for LTS lines, which .nvmrc accepts as lts/<name>.
const LTS_MAJORS: Record<string, number> = {
  argon: 4,
  boron: 6,
  carbon: 8,
  dubnium: 10,
  erbium: 12,
  fermium: 14,
  gallium: 16,
  hydrogen: 18,
  iron: 20,
  jod: 22,
  krypton: 24,
};

function pinnedMajor(version: string): number | null {
  const numeric = version.match(/^v?(\d+)(?:\.\d+){0,2}$/);
  if (numeric) return Number(numeric[1]);
  const lts = version.match(/^lts\/([a-z]+)$/i);
  return lts ? (LTS_MAJORS[lts[1]?.toLowerCase() ?? ""] ?? null) : null;
}

// Returns the old pin and the file's new content when it pins a Node.js older than cf
// supports, or null when it's new enough or reads as something else (such as lts/* or node).
export function raiseNodeVersion(text: string): { from: string; text: string } | null {
  const from = text.replace(/^﻿/, "").split(/\r?\n/)[0]?.trim() ?? "";
  const major = pinnedMajor(from);
  return major !== null && major < MIN_NODE_MAJOR ? { from, text: `${MIN_NODE_MAJOR}\n` } : null;
}

// pnpm 11 lists a dependency whose build script it skipped under allowBuilds in
// pnpm-workspace.yaml with this value, and installs fail until someone decides.
const UNDECIDED = /^(\s+)(['"]?)([^\s'":]+)\2:\s*set this to true or false\s*$/gm;

// The packages pnpm-workspace.yaml marks for a build-script decision.
export function undecidedBuilds(text: string): string[] {
  return [...text.matchAll(UNDECIDED)].map((m) => m[3] ?? "");
}

// Allows the build scripts of the given undecided packages.
export function approveBuilds(text: string, names: readonly string[]): string {
  return text.replace(UNDECIDED, (line, indent: string, quote: string, name: string) =>
    names.includes(name) ? `${indent}${quote}${name}${quote}: true` : line,
  );
}
