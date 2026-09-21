/** pino redaction (report §4.3): never log contact data, credentials or cookies. */
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'res.headers["set-cookie"]',
  "*.password",
  "*.token",
  "*.secret",
  "*.phone",
  "*.email",
];
