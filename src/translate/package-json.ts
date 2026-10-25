export interface PackageJson {
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  // npm, Yarn and bun workspace patterns, from either the list or the { packages } form.
  workspaces?: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Keeps only the entries whose values are strings, so a malformed version
// can't leak into callers that expect Record<string, string>.
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

// Invalid fields are left out rather than rejecting the whole file, so one
// odd field doesn't hide the rest of the project's metadata.
export function parsePackageJson(text: string | null): PackageJson | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const dependencies = stringRecord(parsed.dependencies);
  const devDependencies = stringRecord(parsed.devDependencies);
  const declared = isPlainObject(parsed.workspaces) ? parsed.workspaces.packages : parsed.workspaces;
  const workspaces = Array.isArray(declared) ? declared.filter((w): w is string => typeof w === "string") : undefined;
  return {
    ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
    ...(typeof parsed.packageManager === "string" ? { packageManager: parsed.packageManager } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(devDependencies ? { devDependencies } : {}),
    ...(workspaces ? { workspaces } : {}),
  };
}

export function allDependencies(pkg: PackageJson | null): Record<string, string> {
  return { ...pkg?.dependencies, ...pkg?.devDependencies };
}
