import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { newId } from "../ids";

/**
 * Envelope encryption (report §12.5). A random 256-bit data key encrypts values; the data key itself is
 * stored wrapped by LUME_MASTER_KEY. Every ciphertext names the key that made it, so keys can rotate
 * without re-encrypting old data. The caller's `context` (e.g. "totp:<userId>") is authenticated too,
 * so a ciphertext copied onto another row fails to decrypt.
 *
 * Layout: [version 1B][keyId 16B][iv 12B][tag 16B][ciphertext]
 */
const VERSION = 1;
export type StoredKey = { id: string; wrapped: Buffer; active: boolean };

const idToBytes = (id: string) => Buffer.from(id.replace(/-/g, ""), "hex");
const bytesToId = (b: Buffer) => {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function seal(key: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv).setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function open(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12)).setAAD(aad);
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export function masterKeyFromBase64(b64: string): Buffer {
  const k = Buffer.from(b64, "base64");
  if (k.length < 32) throw new Error("LUME_MASTER_KEY must decode to at least 32 bytes");
  return k.subarray(0, 32);
}

export function newStoredKey(master: Buffer): StoredKey {
  const id = newId();
  const dataKey = randomBytes(32);
  return { id, wrapped: seal(master, dataKey, Buffer.from(`lume-data-key:${id}`)), active: true };
}

export class Keyring {
  private constructor(
    private readonly keys: Map<string, Buffer>,
    readonly activeKeyId: string,
  ) {}

  /** Unwraps every stored key; throws if the master key is wrong or no key is active. */
  static create(master: Buffer, stored: StoredKey[]): Keyring {
    const keys = new Map<string, Buffer>();
    for (const k of stored) keys.set(k.id, open(master, k.wrapped, Buffer.from(`lume-data-key:${k.id}`)));
    const active = stored.filter((k) => k.active);
    if (active.length !== 1) throw new Error(`expected exactly one active data key, found ${active.length}`);
    return new Keyring(keys, active[0]!.id);
  }

  encrypt(plain: string, context: string): Buffer {
    const idBytes = idToBytes(this.activeKeyId);
    const body = seal(
      this.keys.get(this.activeKeyId)!,
      Buffer.from(plain, "utf8"),
      Buffer.concat([idBytes, Buffer.from(context)]),
    );
    return Buffer.concat([Buffer.from([VERSION]), idBytes, body]);
  }

  decrypt(blob: Buffer, context: string): string {
    if (blob[0] !== VERSION) throw new Error("unknown ciphertext version");
    const idBytes = blob.subarray(1, 17);
    const key = this.keys.get(bytesToId(idBytes));
    if (!key) throw new Error("ciphertext was made with an unknown data key");
    return open(key, blob.subarray(17), Buffer.concat([idBytes, Buffer.from(context)])).toString("utf8");
  }
}
