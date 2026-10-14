const normalise = (line: string) => line.trim().replace(/^\//, "").replace(/\/$/, "");

export function addGitignoreEntries(existing: string, entries: readonly string[]): string {
  const present = new Set(existing.split(/\r?\n/).map(normalise));
  const missing = entries.filter((e) => !present.has(normalise(e)));
  if (!missing.length) return existing;
  const base = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${base}\n# Added by Switchyard\n${missing.join("\n")}\n`;
}
