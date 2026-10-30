import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Snapshot } from "./snapshot.js";

interface StateFile {
  version: 1;
  pr: string;
  snapshot: Snapshot;
}

/** Load the last snapshot for `pr`, or null if absent, unreadable, or for another PR. */
export async function loadState(path: string, pr: string): Promise<Snapshot | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as StateFile;
    if (parsed.version === 1 && parsed.pr === pr && parsed.snapshot) return parsed.snapshot;
  } catch {
    /* corrupt state is treated as no state */
  }
  return null;
}

export async function saveState(path: string, pr: string, snapshot: Snapshot): Promise<void> {
  const body: StateFile = { version: 1, pr, snapshot };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(body)}\n`);
  await rename(tmp, path);
}
