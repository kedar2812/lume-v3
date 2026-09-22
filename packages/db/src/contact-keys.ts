import { createHash } from "node:crypto";

/** JS twin of SQL lead_contact_key_hash(): values must already be normalised (E.164, lower-case). */
export const contactKeyHash = (kind: "phone" | "email" | "instagram", value: string): string =>
  createHash("sha256").update(`${kind}:${value}`, "utf8").digest("hex");
