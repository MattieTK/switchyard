import { satisfies, validRange } from "semver";
import { type IncompatibleDependency, incompatibleDependencyWarning } from "./next-codemod-output.ts";

// A package's newest release, as the registry describes it.
export interface LatestRelease {
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
function supports(release: LatestRelease, flagged: IncompatibleDependency): boolean {
  return flagged.peers.every(({ name, found }) => {
    const range = release.peerDependencies?.[name];
    return range === undefined || (validRange(range) !== null && satisfies(found, range, { includePrerelease: true }));
  });
}

// Decides which packages the upgrade flagged can move to their latest release. direct holds
// the packages package.json lists, and latest the registry's answer for each, or null when
// it couldn't be read. Returns the updates to install and a warning for each package.
export function planFlaggedUpdates(
  flagged: readonly IncompatibleDependency[],
  direct: Readonly<Record<string, string>>,
  latest: ReadonlyMap<string, LatestRelease | null>,
): { updates: FlaggedUpdate[]; warnings: string[] } {
  const updates: FlaggedUpdate[] = [];
  const warnings: string[] = [];
  for (const p of flagged) {
    const peers = p.peers.map((x) => `${x.name} ${x.found}`).join(" and ");
    const release = latest.get(p.name);
    if (!(p.name in direct)) {
      warnings.push(
        `${incompatibleDependencyWarning(p)} Switchyard didn't update it, because it comes from another package rather than package.json.`,
      );
    } else if (!release) {
      warnings.push(`${incompatibleDependencyWarning(p)} Switchyard couldn't look up its latest release, so it wasn't updated.`);
    } else if (!supports(release, p)) {
      warnings.push(
        `${incompatibleDependencyWarning(p)} Its latest release, ${release.version}, doesn't declare support for ${peers} either, so Switchyard left it as it was.`,
      );
    } else {
      updates.push({ name: p.name, from: p.version, to: `^${release.version}` });
      warnings.push(
        `Switchyard updated ${p.name} from ${p.version} to ^${release.version}, the latest release, because ${p.version} doesn't support ${peers}. A major update can change its API, so check its changelog.`,
      );
    }
  }
  return { updates, warnings };
}
