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
  /**
   * The links (event type URIs) whose bookings are leads' (owner 2026-11-27): a booking on any other is dropped on
   * arrival, never stored. null (a Calendly connected before this) takes every link until an admin chooses.
   */
  links?: string[] | null;
  /** LUME's booking link: the one LUME books calls on in Calendly (Schedule a meeting); one of `links`. */
  bookWith?: string | null;
  /** The booking link's own page and name, as Calendly listed them when it was chosen (LUME AI shares the page). */
  bookUrl?: string | null;
  bookName?: string | null;
  /** Calendly stopped listing the booking link (the daily check): LUME AI offers the call times until it's back. */
  bookGone?: boolean;
};
export const CALENDLY_DEFAULTS: CalendlySettings = {
  createLeads: true,
  rescheduleFollowUp: true,
  phoneQuestion: null,
  links: null,
  bookWith: null,
};

/** A booking on this link is a lead's: every link until chosen (null), else only the chosen ones. */
export const leadLink = (s: CalendlySettings, link: string) => s.links == null || s.links.includes(link);

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
