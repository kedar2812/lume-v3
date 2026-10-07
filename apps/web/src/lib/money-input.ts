/**
 * An amount as a person types it: grouping commas (1,50,000), spaces and a currency sign or code (₹, $, INR) are
 * fine; hex ("0x1F"), scientific ("1e5"), negatives and more than two decimals are refused in words.
 */
export function parseAmount(raw: string): { value: number | null } | { error: string } {
  const t = raw
    .trim()
    .replace(/^(\p{Sc}|[A-Za-z]{2,3}\.?)\s*(?=[\d.,])/u, "")
    .replace(/[\s,']/g, "");
  if (!t) return { value: null };
  if (/^-/.test(t)) return { error: "Enter an amount of 0 or more" };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return { error: "Enter an amount, like 25,000" };
  if (/\.\d{3,}$/.test(t)) return { error: "Use at most two decimals" };
  return { value: Number(t) };
}
