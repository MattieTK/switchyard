export interface PackageJson {
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function parsePackageJson(text: string | null): PackageJson | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

export function allDependencies(pkg: PackageJson | null): Record<string, string> {
  return { ...pkg?.dependencies, ...pkg?.devDependencies };
}
