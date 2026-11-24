/**
 * Every project's time limits. A project doesn't inherit the root config's test options, so each project config
 * spreads these: without them a slow harness setup on a busy box fails at Vitest's 10 s default.
 */
export const TIME_LIMITS = { testTimeout: 30_000, hookTimeout: 60_000 } as const;
