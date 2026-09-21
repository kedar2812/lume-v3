// Builds packages/core/data/breached-sha1.bin: the UK NCSC top-100k passwords as sorted raw SHA-1 digests
// (20 bytes each), so the API can binary-search without ever holding plaintext passwords.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const SRC =
  "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt";
const res = await fetch(SRC);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const words = [
  ...new Set(
    (await res.text())
      .split(/\r?\n/)
      .map((w) => w.trim())
      .filter(Boolean),
  ),
];
const digests = words.map((w) => createHash("sha1").update(w, "utf8").digest()).sort(Buffer.compare);
await mkdir("packages/core/data", { recursive: true });
await writeFile("packages/core/data/breached-sha1.bin", Buffer.concat(digests));
console.log(`wrote ${digests.length} digests (${digests.length * 20} bytes)`);
