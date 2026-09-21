import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const DIGEST = 20;

/** `sorted` holds raw SHA-1 digests in ascending order (see scripts/build-breached-list.mjs). */
export function createBreachedChecker(sorted: Buffer): (pw: string) => boolean {
  if (sorted.length % DIGEST !== 0) throw new Error("breached list is not a whole number of SHA-1 digests");
  const n = sorted.length / DIGEST;
  return (pw) => {
    const d = createHash("sha1").update(pw, "utf8").digest();
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = Buffer.compare(sorted.subarray(mid * DIGEST, mid * DIGEST + DIGEST), d);
      if (c === 0) return true;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  };
}

export async function loadBreachedChecker(file: string): Promise<(pw: string) => boolean> {
  return createBreachedChecker(await readFile(file));
}
