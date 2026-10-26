import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  configDir: string;
  cacheDir: string;
  credentialsFile: string;
  // Choices that aren't secret, such as the preferred agent.
  preferencesFile: string;
  jobsDir: string;
  workDir: string;
  // Package manager shims Switchyard sets up through corepack.
  binDir: string;
}

export function resolvePaths(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Paths {
  const base = env.SWITCHYARD_HOME;
  const configDir = base
    ? join(base, "config")
    : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "switchyard");
  const cacheDir = base
    ? join(base, "cache")
    : join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "switchyard");
  return {
    configDir,
    cacheDir,
    credentialsFile: join(configDir, "credentials.json"),
    preferencesFile: join(configDir, "preferences.json"),
    jobsDir: join(configDir, "jobs"),
    workDir: join(cacheDir, "work"),
    binDir: join(cacheDir, "bin"),
  };
}
