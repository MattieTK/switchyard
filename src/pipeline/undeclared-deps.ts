// Packages sometimes import other packages without listing them as dependencies.
// That works while something else happens to install them, and breaks when an
// upgrade changes the dependency tree. These helpers find such imports in a failed
// build and work out which version the project had before.

export interface UndeclaredImport {
  // The package that couldn't be found.
  packageName: string;
  // The installed package that imports it.
  importer: string;
}

// Rolldown (Vite 8) and Rollup report the same way.
const UNRESOLVED = /(?:Rolldown|Rollup) failed to resolve import "([^"]+)" from "([^"]+)"/g;

// The package part of a bare specifier: "@babel/runtime/regenerator" gives "@babel/runtime".
function packageNameOf(specifier: string): string | null {
  if (/^(\.|\/|#|~|\0|node:|virtual:|[a-z]+:\/\/)/.test(specifier)) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  // A valid npm name: lower case, no spaces, at most one scope.
  return name && /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name) ? name : null;
}

// The installed package a file belongs to, from the last node_modules segment of its path.
function packageOfPath(path: string): string | null {
  const rest = path.split("/node_modules/").at(-1);
  if (!rest || rest === path) return null;
  const parts = rest.split("/");
  return rest.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? null);
}

// Only imports made from inside node_modules count. Bare-looking imports in the app's own
// code are often path aliases, and Switchyard must never install a guessed name from npm.
export function findUndeclaredImports(output: string): UndeclaredImport[] {
  const found = new Map<string, UndeclaredImport>();
  for (const [, specifier = "", from = ""] of output.matchAll(UNRESOLVED)) {
    const packageName = packageNameOf(specifier);
    const importer = packageOfPath(from);
    if (packageName && importer && importer !== packageName && !found.has(packageName)) {
      found.set(packageName, { packageName, importer });
    }
  }
  return [...found.values()];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function versionsInLockfile(file: string, text: string, name: string): string[] {
  if (file.endsWith("package-lock.json") || file.endsWith("npm-shrinkwrap.json")) {
    try {
      const lock = JSON.parse(text) as { packages?: Record<string, { version?: string }> };
      return Object.entries(lock.packages ?? {})
        .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
        .flatMap(([, entry]) => (entry.version ? [entry.version] : []));
    } catch {
      return [];
    }
  }
  if (file.endsWith("yarn.lock")) {
    // Each entry is a header listing the requested ranges, followed by the resolved version.
    return text.split(/\n\s*\n/).flatMap((block) => {
      const [header = "", ...rest] = block.trim().split("\n");
      const specs = header.replace(/:$/, "").split(/,\s*/).map((s) => s.replace(/^"|"$/g, ""));
      if (!specs.some((s) => s.startsWith(`${name}@`))) return [];
      const version = rest.join("\n").match(/^\s+version:? "?([^"\s]+)"?/m)?.[1];
      return version ? [version] : [];
    });
  }
  // pnpm-lock.yaml ("/name/1.2.3:" or "name@1.2.3:") and bun.lock ("name@1.2.3").
  const pattern = new RegExp(`(?:^|[\\s'"/])${escape(name)}[@/](\\d+\\.\\d+\\.\\d+[\\w.+-]*)`, "gm");
  return [...text.matchAll(pattern)].map((m) => m[1] ?? "").filter(Boolean);
}

// The highest version of a package in a lockfile, or null when it wasn't installed.
export function previousVersion(file: string, text: string, name: string): string | null {
  const versions = versionsInLockfile(file, text, name);
  return versions.length ? versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)) : null;
}
