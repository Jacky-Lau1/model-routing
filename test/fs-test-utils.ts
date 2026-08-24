import { readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";

// Windows `fs.rm({ recursive: true })` can hang indefinitely on freshly created
// trees (copied build output and git repositories are the worst offenders). A
// manual readdir + unlink + rmdir walk completes reliably, so every temporary
// root cleanup in the test suite goes through this helper instead.
export async function rmrf(dir: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) await rmrf(target);
    else await rm(target, { force: true }).catch(() => {});
  }
  await rmdir(dir).catch(() => {});
}
