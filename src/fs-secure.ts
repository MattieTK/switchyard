import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Writes atomically (temp file + rename) so a crash never leaves a half-written
// credentials or secrets file, and keeps both the file and its folder private.
export async function writeFileSecure(file: string, data: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, file);
}
