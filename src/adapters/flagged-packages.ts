import { compare, prerelease, satisfies, valid, validRange } from "semver";
import { type IncompatibleDependency, incompatibleDependencyWarning } from "./next-codemod-output.ts";

// A release of a package, as the registry describes it.
export interface Release {
  version: string;
  peerDependencies?: Record<string, string>;
}

export interface FlaggedUpdate {
  name: string;
  from: string;
  to: string;
}

// Whether a release accepts every version the upgrade installed. A peer the release no
// longer declares puts no limit on it.
function supports(release: Release, flagged: IncompatibleDependency): boolean {
  return flagged.peers.every(({ name, found }) => {
    const range = release.peerDependencies?.[name];
    return range === undefined || (validRange(range) !== null && satisfies(found, range, { includePrerelease: true }));
  });
}

// The lowest stable release that supports what the upgrade installed, which keeps the
// update as small as it can be.
function smallestUpdate(releases: readonly Release[], flagged: IncompatibleDependency): Release | null {
  const stable = releases.filter((r) => valid(r.version) && !prerelease(r.version));
  return [...stable].sort((a, b) => compare(a.version, b.version)).find((r) => supports(r, flagged)) ?? null;
}

// Decides which packages the upgrade flagged can move to a release that supports what the
// upgrade installed. direct holds the packages package.json lists, and newer the registry's
// releases after the installed one for each, or null when they couldn't be read. Returns the
// updates to install and a warning for each package.
export function planFlaggedUpdates(
  flagged: readonly IncompatibleDependency[],
  direct: Readonly<Record<string, string>>,
  newer: ReadonlyMap<string, readonly Release[] | null>,
): { updates: FlaggedUpdate[]; warnings: string[] } {
  const updates: FlaggedUpdate[] = [];
  const warnings: string[] = [];
  for (const p of flagged) {
    const peers = p.peers.map((x) => `${x.name} ${x.found}`).join(" and ");
    const releases = newer.get(p.name);
    const release = releases ? smallestUpdate(releases, p) : null;
    if (!(p.name in direct)) {
      warnings.push(
        `${incompatibleDependencyWarning(p)} Switchyard didn't update it, because it comes from another package rather than package.json.`,
      );
    } else if (!releases) {
      warnings.push(`${incompatibleDependencyWarning(p)} Switchyard couldn't look up its releases, so it wasn't updated.`);
    } else if (!release) {
      warnings.push(
        `${incompatibleDependencyWarning(p)} No newer release declares support for ${peers} either, so Switchyard left it as it was.`,
      );
    } else {
      updates.push({ name: p.name, from: p.version, to: `^${release.version}` });
      const major = valid(p.version) && valid(release.version) && release.version.split(".")[0] !== p.version.split(".")[0];
      warnings.push(
        `Switchyard updated ${p.name} from ${p.version} to ^${release.version}, the first release that supports ${peers}.${major ? " It's a major update, which can change its API, so check its changelog." : ""}`,
      );
    }
  }
  return { updates, warnings };
}
