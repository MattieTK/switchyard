export interface UnmetPeer {
  name: string;
  range: string;
  found: string;
}

const HEADER = /seem incompatible with the upgraded package versions\.$/;
const PACKAGE_LINE = /^(\S+) (\S+)$/;
const PEER_LINE = /^\s+[├└]── ✕ unmet peer (.+)@"(.+)": found (\S+)$/;

const list = (items: string[]) => items.join(" and ");

// A package the upgrade reported, with the peers it declares that the upgrade left unmet.
export interface IncompatibleDependency {
  name: string;
  version: string;
  peers: UnmetPeer[];
}

// Reads the "dependencies that seem incompatible" report @next/codemod upgrade prints at the end.
export function incompatibleDependencies(output: string): IncompatibleDependency[] {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => HEADER.test(line));
  if (start === -1) return [];

  const packages: IncompatibleDependency[] = [];
  // The line after the header is advice, so packages start two lines down.
  for (const line of lines.slice(start + 2)) {
    const peer = line.match(PEER_LINE);
    const current = packages.at(-1);
    if (peer && current) {
      current.peers.push({ name: peer[1] ?? "", range: peer[2] ?? "", found: peer[3] ?? "" });
      continue;
    }
    const pkg = line.match(PACKAGE_LINE);
    if (!pkg) break;
    packages.push({ name: pkg[1] ?? "", version: pkg[2] ?? "", peers: [] });
  }
  return packages.filter((p) => p.peers.length > 0);
}

// The pull request warning for a package the upgrade reported.
export function incompatibleDependencyWarning(p: IncompatibleDependency): string {
  return `${p.name} ${p.version} supports ${list(p.peers.map((x) => `${x.name} ${x.range}`))}, but the upgrade installed ${list(p.peers.map((x) => `${x.name} ${x.found}`))}. If the build or the app fails, update or replace it.`;
}

// Turns each package in the report into a warning for the pull request.
export function incompatibleDependencyWarnings(output: string): string[] {
  return incompatibleDependencies(output).map(incompatibleDependencyWarning);
}
