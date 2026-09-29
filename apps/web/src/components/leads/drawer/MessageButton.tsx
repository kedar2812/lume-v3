"use client";
import type { TemplateCategory } from "@lume/core/shared";
import { SendSheet } from "@/components/messages/SendSheet";
import type { Lead } from "@/lib/leads/types";
import s from "./drawer.module.css";

/** Why WhatsApp can't open for this lead, or null when it can. */
export function whatsappBlocked(lead: Lead): string | null {
  const status = lead.phone?.status ?? "missing";
  if (status === "valid") return null;
  if (status === "needs_country") return "This number needs a country code";
  return "No WhatsApp number";
}

/**
 * The drawer's WhatsApp (report §11.2; 4A): the send sheet, and a plain line saying why when a lead's
 * number can't be messaged. The link is built by the server and never shown.
 */
export function MessageButton({
  lead,
  suggest,
  onChange,
}: {
  lead: Lead;
  suggest?: TemplateCategory;
  onChange: () => void;
}) {
  const blocked = whatsappBlocked(lead);
  return (
    <div className={s.message}>
      <SendSheet
        lead={{ id: lead.id, name: lead.name ?? "Unnamed lead" }}
        blocked={blocked}
        {...(suggest ? { suggest } : {})}
        onChange={onChange}
      />
      {blocked && <p className={s.why}>{blocked}</p>}
    </div>
  );
}
