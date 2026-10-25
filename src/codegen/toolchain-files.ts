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
const UNDECIDED = /^([ \t]+)(['"]?)([^\s'":]+)\2:[ \t]*set this to true or false[ \t]*$/gm;

// The packages pnpm-workspace.yaml marks for a build-script decision.
export function undecidedBuilds(text: string): string[] {
  return [...text.matchAll(UNDECIDED)].map((m) => m[3] ?? "");
}

// Allows (or, with false, refuses) the build scripts of the given undecided packages.
export function approveBuilds(text: string, names: readonly string[], allow = true): string {
  return text.replace(UNDECIDED, (line, indent: string, quote: string, name: string) =>
    names.includes(name) ? `${indent}${quote}${name}${quote}: ${allow}` : line,
  );
}

// pnpm 12 writes no placeholders: it skips the build scripts of packages not under allowBuilds,
// and an install with CI set, as on Workers Builds, fails with ERR_PNPM_IGNORED_BUILDS.
// `pnpm ignored-builds` lists those packages, indented under this heading.
const IGNORED_HEADING = "Automatically ignored builds during installation:";
const PACKAGE_NAME = /^\s+((?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+)\s*$/;

// The packages `pnpm ignored-builds` reports as skipped.
export function ignoredBuildsFrom(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === IGNORED_HEADING);
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(PACKAGE_NAME);
    // "None", or a sentence such as "Cannot identify as no node_modules found", ends the list.
    if (!m?.[1]) break;
    names.push(m[1]);
  }
  return names;
}

const ALLOW_BUILDS_KEY = /^allowBuilds:[ \t]*(\S.*)?$/m;

// Allows (or, with false, refuses) the build scripts of the given packages under allowBuilds in
// pnpm-workspace.yaml, leaving any package already listed as it is. Returns null when the
// setting is written inline, which would need a YAML parser to extend safely.
export function allowBuildsIn(
  text: string,
  names: readonly string[],
  allow = true,
): { text: string; added: string[] } | null {
  const key = ALLOW_BUILDS_KEY.exec(text);
  if (key?.[1]) return null;
  // Only the entries directly under the key, not those of a later setting.
  const block = key ? (text.slice(key.index + key[0].length).match(/^(?:\r?\n[ \t]+[^\n]*)*/)?.[0] ?? "") : "";
  const listed = new Set([...block.matchAll(/^[ \t]+(['"]?)([^\s'":]+)\1[ \t]*:/gm)].map((m) => m[2]));
  const added = names.filter((n) => !listed.has(n));
  if (!added.length) return { text, added };
  const entries = added.map((n) => `  "${n}": ${allow}`).join("\n");
  if (key) {
    const end = key.index + key[0].length + block.length;
    return { text: `${text.slice(0, end)}\n${entries}${text.slice(end)}`, added };
  }
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return { text: `${base}${base ? "\n" : ""}allowBuilds:\n${entries}\n`, added };
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

// Vercel installs a project with a Yarn 1 lockfile using Yarn 1 unless package.json names
// another version. Yarn 4, which Workers Builds and current Yarn installs default to,
// would instead rewrite the lockfile and switch the project to Plug'n'Play.
export const YARN_1_VERSION = "1.22.22";

export function isYarn1Lockfile(text: string): boolean {
  return /^# yarn lockfile v1\s*$/m.test(text);
}
