/** What the owner sends a client with their key (spec 2026-10-15 §3.1): their address, the key, and one server. */
export const clientMessage = (slug: string, key: string): string =>
  `Your LUME is ready. Open https://${slug}.lumecrm.in and enter this product key when asked: ${key}. It works on one server only, so keep it private.`;

/** The same text, opened in WhatsApp: to the client's number when there is one (digits only), else to choose a chat. */
export function whatsappLink(text: string, phone?: string | null): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
