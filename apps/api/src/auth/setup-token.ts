import { randomToken } from "@lume/core";

/** The one-time first-run token, printed in the API logs while zero users exist (report §15.3). */
export type SetupTokens = { current(): string | null; burn(): void };

export function processSetupTokens(needsSetup: boolean, log: (msg: string) => void): SetupTokens {
  let token = needsSetup ? randomToken(24) : null;
  if (token)
    log(
      `LUME first-run setup token: ${token} (open /setup and paste it; valid until the owner account exists)`,
    );
  return { current: () => token, burn: () => void (token = null) };
}
