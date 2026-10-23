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

// Yarn 4 refuses releases newer than npmMinimalAgeGate (a day unless the project sets it).
// It names a dependency it held back as "name@npm:version: All versions satisfying ... are
// quarantined", and a package it was asked to add as "name@range can't be resolved".
const QUARANTINED_DEPENDENCY = /YN0016:[\s│]*((?:@[^/\s@]+\/)?[^\s@:]+)@npm:/g;
const UNRESOLVED_REQUEST = /YN0027:[\s│]*((?:@[^/\s@]+\/)?[^\s@]+)@\S* can't be resolved/g;

// The packages Yarn held back because of their release age, in the order it reported them.
export function quarantinedPackages(output: string): string[] {
  if (!output.includes("are quarantined")) return [];
  const names = [...output.matchAll(UNRESOLVED_REQUEST), ...output.matchAll(QUARANTINED_DEPENDENCY)].map((m) => m[1] ?? "");
  return [...new Set(names.filter(Boolean))];
}

const PREAPPROVED_KEY = /^npmPreapprovedPackages:[ \t]*(\S.*)?$/m;

// Adds packages to npmPreapprovedPackages in .yarnrc.yml, which exempts them from Yarn's
// release-age gate. Returns null when the setting is written in a form this can't extend.
export function preapproveYarnPackages(
  text: string,
  packages: readonly string[],
): { text: string; added: string[] } | null {
  const key = PREAPPROVED_KEY.exec(text);
  // An inline list such as [a, b] would need a YAML parser to extend safely.
  if (key?.[1]) return null;
  // Only the items directly under the key, not those of a later list.
  const block = key ? (text.slice(key.index + key[0].length).match(/^(?:\r?\n[ \t]+-[^\n]*)*/)?.[0] ?? "") : "";
  const listed = new Set([...block.matchAll(/-[ \t]+["']?([^"'\s]+)["']?[ \t]*$/gm)].map((m) => m[1]));
  const added = packages.filter((p) => !listed.has(p));
  if (!added.length) return { text, added };
  const items = added.map((p) => `  - "${p}"`).join("\n");
  if (key) {
    const end = key.index + key[0].length;
    return { text: `${text.slice(0, end)}\n${items}${text.slice(end)}`, added };
  }
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return { text: `${base}${base ? "\n" : ""}npmPreapprovedPackages:\n${items}\n`, added };
}
