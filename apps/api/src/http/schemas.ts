import { z } from "zod";

/** Shared request-body building blocks, so every route validates these the same way. */
export const emailSchema = z.email().max(254);
export const passwordInput = z.string().min(1).max(256);
export const nameSchema = z.string().trim().min(1).max(120);
export const timezoneSchema = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, "unknown timezone");
export const totpCodeSchema = z.string().regex(/^\d{6}$/);
/** randomToken() output: 32 bytes, base64url. */
export const urlTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
