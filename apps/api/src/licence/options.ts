import { existsSync, readFileSync } from "node:fs";
import product from "../../../../package.json" with { type: "json" };
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
  /** The keys this build trusts (tests pass their own). */
  keys?: Record<string, string>;
}): LicenceOptions {
  const e = o.env;
  const compiled = o.keys ?? LICENCE_KEYS;
  // A release that trusts no key would accept no answer, and every client would lock 7 days after updating.
  if (o.release && Object.keys(compiled).length === 0)
    throw new Error(
      "This release build of LUME has no licence keys (packages/core/src/licence/keys.ts): it would refuse every licence. Build it again with the licence server's public key.",
    );
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
    keys: { ...compiled, ...extra },
    version: o.version,
  };
}

/**
 * The version an installation reports (Settings → About, the licence check, the licence server's Releases):
 * a release image's own (LUME_VERSION, baked in at build), else LUME's version from the root package.json.
 */
export function appVersion(env: { LUME_VERSION?: string }): string {
  return env.LUME_VERSION?.trim() || product.version;
}
