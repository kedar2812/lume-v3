import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * A secret sealed with LICENCE_MASTER_KEY (AES-256-GCM), bound to what it's for ("totp:<admin id>",
 * "key:<client id>"): a blob moved to another row, or opened for another purpose, never opens.
 * Layout: 12-byte IV, 16-byte tag, then the ciphertext.
 */
export function seal(master: Buffer, plain: string, purpose: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", master, iv).setAAD(Buffer.from(purpose));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function unseal(master: Buffer, blob: Buffer, purpose: string): string {
  const d = createDecipheriv("aes-256-gcm", master, blob.subarray(0, 12)).setAAD(Buffer.from(purpose));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8");
}
