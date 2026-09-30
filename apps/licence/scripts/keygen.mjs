#!/usr/bin/env node
// The licence server's signing key pair (spec §2), made once, on the licence server's host:
//   node scripts/keygen.mjs /root/lume-licence/secrets/signing.pem --kid lume-1
// The private key is written readable only by its owner and never printed. The public key is printed, to
// be added to packages/core/src/licence/keys.ts (LUME's releases trust only the keys listed there).
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--kid");
const kidAt = args.indexOf("--kid");
const kid = kidAt >= 0 ? args[kidAt + 1] : "lume-1";
if (!file || !kid || !/^[a-z0-9-]{1,32}$/.test(kid)) {
  console.error("usage: keygen.mjs <private-key-file> [--kid lume-1]");
  process.exit(2);
}
if (existsSync(file)) {
  console.error(`${file} already exists. A second key would orphan every instance that trusts the first.`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
// Ed25519's SubjectPublicKeyInfo is a 12-byte prefix and the raw 32-byte key.
const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64url");
console.log(`Private key written to ${file} (mode 600). Keep it there; back it up offline.`);
console.log("");
console.log("Add this line to LICENCE_KEYS in packages/core/src/licence/keys.ts, then cut a release:");
console.log(`  "${kid}": "${raw}",`);
console.log("");
console.log(`And run the licence server with LICENCE_KID=${kid}.`);
