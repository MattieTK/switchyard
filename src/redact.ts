export interface Redactor {
  add(value: string | undefined): void;
  redact(text: string): string;
}

// Values shorter than this are left alone: redacting "true" or "1" everywhere
// would make logs unreadable, and such values are not meaningful secrets.
const MIN_LENGTH = 4;

export function createRedactor(): Redactor {
  const values = new Set<string>();
  let ordered: string[] = [];

  return {
    add(value) {
      if (!value || value.length < MIN_LENGTH) return;
      const escaped = JSON.stringify(value).slice(1, -1);
      for (const v of new Set([value, escaped])) values.add(v);
      // Longest first, so a value never leaves a partial match of a longer one.
      ordered = [...values].sort((a, b) => b.length - a.length);
    },
    redact(text) {
      let out = text;
      for (const v of ordered) out = out.split(v).join("***");
      return out;
    },
  };
}
