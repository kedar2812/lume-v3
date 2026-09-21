import type pg from "pg";
import { Keyring, newStoredKey } from "@lume/core";

/** Loads every data key; on a fresh database creates the first one. */
export async function loadKeyring(pool: pg.Pool, master: Buffer): Promise<Keyring> {
  const { rows } = await pool.query("SELECT id, wrapped, active FROM crypto_keys");
  if (rows.length === 0) {
    const k = newStoredKey(master);
    await pool.query(
      "INSERT INTO crypto_keys (id, wrapped, active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING",
      [k.id, k.wrapped],
    );
    return loadKeyring(pool, master);
  }
  return Keyring.create(master, rows);
}
