import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

// Whether an executable called cmd is on PATH, checked without running anything.
export async function onPath(cmd: string, path: string = process.env.PATH ?? ""): Promise<boolean> {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    try {
      await access(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // Not in this folder.
    }
  }
  return false;
}
