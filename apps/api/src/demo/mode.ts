/** LUME's own public demo; demo mode is honoured at this address only. */
export const DEMO_HOST = "demo.lumecrm.in";

/**
 * Demo mode (LUME_DEMO_MODE=true): two-step sign-in is waived, so a prospect signs in with a password alone. It is
 * honoured only on LUME's own demo address, so a client's install can never turn it on, even with the flag copied
 * into its .env.
 */
export function demoMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.LUME_DEMO_MODE === "true" && env.LUME_PUBLIC_HOST?.trim().toLowerCase() === DEMO_HOST;
}
