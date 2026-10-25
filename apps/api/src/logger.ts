/** pino redaction (report §4.3): never log contact data, credentials or cookies. */
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.token",
  "*.secret",
  "*.code",
  "*.recoveryCodes",
  "*.otpauthUri",
  "*.phone",
  "*.email",
];

/** A line naming a query's bound values: drizzle's "params: …" (review 2026-10-25). */
const PARAMS_LINE = /^params: .*$/gm;
/** What an error may say in the logs; anything else on it (drizzle's `params`, Postgres's `detail`) is left out. */
const KEPT = ["code", "statusCode", "constraint", "table", "column", "routine", "severity"] as const;

/**
 * An error as the logs keep it (review 2026-10-25): its kind, message, stack and codes, with no value it was given. A
 * failed query's bound values (an email, a phone, a password hash) and Postgres's detail ("Key (email)=(…) already
 * exists") never reach the logs; nor through its cause.
 */
export function safeErr(err: unknown, depth = 0): unknown {
  if (!err || typeof err !== "object") return err;
  const e = err as Record<string, unknown> & { message?: unknown; stack?: unknown; cause?: unknown };
  const out: Record<string, unknown> = { type: (err as object).constructor?.name ?? "Error" };
  if (typeof e.message === "string") out.message = e.message.replace(PARAMS_LINE, "params: [redacted]");
  if (typeof e.stack === "string") out.stack = e.stack.replace(PARAMS_LINE, "params: [redacted]");
  for (const k of KEPT) if (typeof e[k] === "string" || typeof e[k] === "number") out[k] = e[k];
  if (e.cause && depth < 3) out.cause = safeErr(e.cause, depth + 1);
  return out;
}

/** The API's logger: redacted paths, and errors as safeErr keeps them. */
export const loggerOptions = (level: string) => ({
  level,
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  serializers: { err: (e: Error) => safeErr(e) as { type: string; message: string; stack: string } },
});
