import type { Keyring, Mapping } from "@lume/core";

/** What a booking says, as the intake engine reads it (one row per booking, these columns). */
export const CALENDLY_HEADERS = ["Name", "Email", "Phone", "Host email"];
/** Name, email and phone to the lead; the host's email to its owner when they're a LUME person. */
export const CALENDLY_MAPPING: Mapping = {
  columns: [
    { column: 0, to: "field", field: "name" },
    { column: 1, to: "field", field: "email" },
    { column: 2, to: "field", field: "phone" },
    { column: 3, to: "field", field: "owner" },
  ],
  createMissingTags: false,
};

export type CalendlySettings = {
  /** A booking from someone who isn't a lead yet makes one (spec §3: a switch, on). */
  createLeads: boolean;
  /** A cancellation sets the owner a "Reschedule" follow-up (a switch, on). */
  rescheduleFollowUp: boolean;
  /** The booking question whose answer is the phone, when Calendly's own SMS number isn't asked. */
  phoneQuestion: string | null;
};
export const CALENDLY_DEFAULTS: CalendlySettings = {
  createLeads: true,
  rescheduleFollowUp: true,
  phoneQuestion: null,
};

/** Sealed in config_enc, bound to the source: the token and signing key never leave it. */
export type CalendlyConfig = {
  token: string;
  signingKey: string;
  subscription: string;
  scope: "organization" | "user";
  organization: string;
  user: string;
  account: { name: string; email: string };
  settings: CalendlySettings;
};
const ctx = (id: string) => `calendly-source:${id}`;
export const sealCalendly = (k: Keyring, id: string, c: CalendlyConfig): Buffer =>
  k.encrypt(JSON.stringify(c), ctx(id));
export const openCalendly = (k: Keyring, id: string, blob: Buffer): CalendlyConfig =>
  JSON.parse(k.decrypt(blob, ctx(id))) as CalendlyConfig;
