import type { SecurityTab } from "@/components/settings/security/SecurityTabs";

/** Security's sections, in the canvas's order. */
export const SECURITY_TABS: SecurityTab[] = [
  { href: "/settings/security", label: "Overview" },
  { href: "/settings/security/rules", label: "Rules" },
  { href: "/settings/security/access", label: "Access limits" },
  { href: "/settings/security/exports", label: "Exports" },
];
export const SECURITY_LEDE =
  "LUME watches for anyone taking more lead data than their work needs, and tells you.";
