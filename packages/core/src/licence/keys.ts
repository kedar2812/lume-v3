/**
 * LUME's licence-signing public keys, by key id, as release images ship them (spec §2). The private halves
 * live only on the licence server's host. A rotation adds a key here; a release build never reads one from
 * its environment.
 */
export const LICENCE_KEYS: Record<string, string> = {};
