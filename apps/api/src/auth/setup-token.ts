import { randomToken } from "@lume/core";

/**
 * The one-time first-run token (report §15.3). Printed for the operator whenever the installation has no
 * users at all — at boot, and again on demand if a wiped installation is asked for its setup status, so
 * resetting an installation can never lock the operator out of setting it up again.
 */
export type SetupTokens = { current(): string | null; ensure(): string; burn(): void };

export function processSetupTokens(needsSetup: boolean, log: (msg: string) => void): SetupTokens {
  let token: string | null = null;
  const mint = () => {
    token = randomToken(24);
    log(
      `LUME first-run setup token: ${token} (open /setup and paste it; valid until the owner account exists)`,
    );
    return token;
  };
  if (needsSetup) mint();
  return { current: () => token, ensure: () => token ?? mint(), burn: () => void (token = null) };
}
