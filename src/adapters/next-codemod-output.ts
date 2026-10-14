interface UnmetPeer {
  name: string;
  range: string;
  found: string;
}

const HEADER = /seem incompatible with the upgraded package versions\.$/;
const PACKAGE_LINE = /^(\S+) (\S+)$/;
const PEER_LINE = /^\s+[├└]── ✕ unmet peer (.+)@"(.+)": found (\S+)$/;

const list = (items: string[]) => items.join(" and ");

// Reads the "dependencies that seem incompatible" report @next/codemod upgrade prints
// at the end, and turns each package into a warning for the pull request.
export function incompatibleDependencyWarnings(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => HEADER.test(line));
  if (start === -1) return [];

  const packages: { name: string; version: string; peers: UnmetPeer[] }[] = [];
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

  return packages
    .filter((p) => p.peers.length > 0)
    .map(
      (p) =>
        `${p.name} ${p.version} supports ${list(p.peers.map((x) => `${x.name} ${x.range}`))}, but the upgrade installed ${list(p.peers.map((x) => `${x.name} ${x.found}`))}. If the build or the app fails, update or replace it.`,
    );
}
