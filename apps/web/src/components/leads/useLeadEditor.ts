"use client";
import { useCallback, useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { leadsClient } from "@/lib/leads/client";
import { fieldErrors } from "@/lib/leads/errors";
import type { FieldDefView, Lead } from "@/lib/leads/types";
import { useCatalog } from "./CatalogProvider";

/** Field key → the lead property it lives in, for core fields. */
const CORE_PROP: Record<string, string> = {
  name: "name",
  phone: "phone",
  email: "email",
  instagram: "instagram",
  value: "value",
  lead_created_at: "leadCreatedAt",
  product: "productId",
};
const CONTACT = new Set(["phone", "email", "instagram"]);
const empty = (v: unknown) =>
  v === "" || v === undefined || v === null || (Array.isArray(v) && v.length === 0);

/** The PATCH body for one field: core fields at the top level, custom ones under `custom`, empty clears. */
export function patchFor(def: FieldDefView, value: unknown): Record<string, unknown> {
  const v = empty(value) ? null : value;
  const core = CORE_PROP[def.key];
  return def.isCore && core ? { [core]: v } : { custom: { [def.key]: v } };
}

/** The value an editor starts from. A contact is editable only when shown in full, so `display` is real. */
export function valueOf(lead: Lead, def: FieldDefView): unknown {
  if (!def.isCore) return lead.custom[def.key];
  const v = (lead as Record<string, unknown>)[CORE_PROP[def.key] ?? def.key];
  if (CONTACT.has(def.key)) return (v as { display?: string } | null | undefined)?.display ?? "";
  return v;
}

export const editable = (lead: Lead, def: FieldDefView): boolean =>
  lead.can.edit &&
  def.access === "edit" &&
  !def.archived &&
  (def.key in CORE_PROP || !def.isCore) &&
  !(CONTACT.has(def.key) && lead.contactMasked);

export type SaveOutcome = "ok" | "conflict" | "invalid" | "failed";

/** Saves one field at a time with If-Match, so two people editing the same lead can never lose work. */
export function useLeadEditor(onUpdated: (lead: Lead) => void) {
  const { toast } = useToast();
  const catalog = useCatalog();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<{ leadId: string; key: string; message: string } | null>(null);

  const save = useCallback(
    async (lead: Lead, def: FieldDefView, value: unknown): Promise<SaveOutcome> => {
      setSaving(`${lead.id}:${def.key}`);
      setError(null);
      const r = await leadsClient.patch(lead.id, lead.version, patchFor(def, value));
      setSaving(null);
      if (r.ok) {
        onUpdated(r.data.lead);
        return "ok";
      }
      if (r.status === 409) {
        const fresh = await leadsClient.get(lead.id);
        if (fresh.ok) onUpdated(fresh.data.lead);
        toast({
          tone: "warn",
          title: `${lead.name ?? "This lead"} was changed by someone else`,
          detail: "Showing the latest. Make your change again if it’s still needed.",
        });
        return "conflict";
      }
      if (r.status === 400 || r.status === 422) {
        const byField = fieldErrors(r, catalog);
        setError({ leadId: lead.id, key: def.key, message: byField[def.key] ?? r.message });
        return "invalid";
      }
      toast({ tone: "danger", title: "That change didn’t save", detail: r.message });
      return "failed";
    },
    [onUpdated, toast, catalog],
  );

  return { save, saving, error, clearError: () => setError(null) };
}
