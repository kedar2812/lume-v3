import { customType, timestamp } from "drizzle-orm/pg-core";

/** Column types Drizzle doesn't ship, shared by every schema file. */
export const citext = customType<{ data: string }>({ dataType: () => "citext" });
export const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
export const inet = customType<{ data: string }>({ dataType: () => "inet" });
export const cidrArray = customType<{ data: string[] }>({ dataType: () => "cidr[]" });
export const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
