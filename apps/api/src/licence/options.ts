import { existsSync, readFileSync } from "node:fs";
import { LICENCE_KEYS } from "@lume/core";

/** How this API holds its licence (licensing L-A, spec §3.1). */
export type LicenceOptions = {
  /** "dev": always active (a development build only); "enforce": check, and act on the answer. */
  mode: "dev" | "enforce";
  instanceId: string | null;
  licenseKey: string | null;
  url: string;
  /** The public keys a token may be signed with, by key id. */
  keys: Record<string, string>;
  version: string;
  /** Tests: the licence server, faked. */
  fetch?: typeof fetch;
};

export const LICENCE_URL = "https://license.lumecrm.in";

/** Baked into a release image at build time (ruling R4): a file, not a variable a client's .env could set. */
export function isReleaseBuild(file = "/app/release.json"): boolean {
  try {
    return (
      existsSync(file) && (JSON.parse(readFileSync(file, "utf8")) as { release?: unknown }).release === true
    );
  } catch {
    return false;
  }
}

/**
 * The licence options for this process. A release build trusts only itself: its compiled-in keys, and
 * always enforcing. A development build is dev unless LUME_LICENSE_MODE=enforce, and may be given a test
 * key (LUME_LICENSE_EXTRA_KEYS, "kid:rawkey,…") so e2e can run against a fake licence server.
 */
export function resolveLicence(o: {
  env: Record<string, string | undefined>;
  release: boolean;
  version: string;
}): LicenceOptions {
  const e = o.env;
  const extra = o.release
    ? {}
    : Object.fromEntries(
        (e.LUME_LICENSE_EXTRA_KEYS ?? "")
          .split(",")
          .map((pair) => pair.trim().split(":"))
          .filter((kv): kv is [string, string] => kv.length === 2 && !!kv[0] && !!kv[1]),
      );
  return {
    mode: o.release || e.LUME_LICENSE_MODE === "enforce" ? "enforce" : "dev",
    instanceId: e.LUME_INSTANCE_ID?.trim() || null,
    licenseKey: e.LUME_LICENSE_KEY?.trim() || null,
    url: (e.LUME_LICENSE_URL?.trim() || LICENCE_URL).replace(/\/$/, ""),
    keys: { ...LICENCE_KEYS, ...extra },
    version: o.version,
  };
}
