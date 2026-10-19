/** What WhatsApp charges for a template, "about": rupees with GST as an Indian business reads them. */
export function aboutCost(c: { amount: number; currency: string }): string {
  if (c.currency === "INR")
    return `about ₹${c.amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })} + GST`;
  try {
    return `about ${new Intl.NumberFormat("en", { style: "currency", currency: c.currency, maximumFractionDigits: 4 }).format(c.amount)}`;
  } catch {
    return `about ${c.currency} ${c.amount}`;
  }
}
