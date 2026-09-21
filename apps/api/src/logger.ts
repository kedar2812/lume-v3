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
