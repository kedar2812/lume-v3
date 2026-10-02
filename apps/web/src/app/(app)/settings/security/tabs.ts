import type { SecurityTab } from "@/components/settings/security/SecurityTabs";

/** Security's sections, in the canvas's order; each joins as it's built. */
export const SECURITY_TABS: SecurityTab[] = [{ href: "/settings/security/rules", label: "Rules" }];
export const SECURITY_LEDE =
  "LUME watches for anyone taking more lead data than their work needs, and tells you.";
