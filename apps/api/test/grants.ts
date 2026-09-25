import { DEFAULT_ROLES } from "@lume/core";

/** The seeded Sales role's grants, so tests track the real role rather than a copy of it. */
export const SALES_GRANTS = DEFAULT_ROLES.find((r) => r.name === "Sales")!.grants;
