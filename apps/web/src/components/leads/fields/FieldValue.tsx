"use client";
import { tokenColor } from "@/lib/leads/colors";
import { fieldText } from "@/lib/leads/format";
import type { FieldDefView, Lead } from "@/lib/leads/types";
import { useCatalog } from "../CatalogProvider";
import { valueOf } from "../useLeadEditor";
import s from "./fields.module.css";

/** A field's value as a person reads it: options as coloured chips, everything else as text, "—" when empty. */
export function FieldValue({ lead, def }: { lead: Lead; def: FieldDefView }) {
  const catalog = useCatalog();
  const value = valueOf(lead, def);
  if (def.type === "select" || def.type === "multi_select") {
    const ids = (Array.isArray(value) ? value : value ? [value] : []) as string[];
    const opts = def.options.filter((o) => ids.includes(o.id));
    if (!opts.length) return <span className={s.empty}>—</span>;
    return (
      <span className={s.chips}>
        {opts.map((o) => (
          <span key={o.id} className={s.chip} style={{ ["--c" as string]: tokenColor(o.color ?? "accent") }}>
            {o.label}
          </span>
        ))}
      </span>
    );
  }
  const text =
    def.isCore && ["phone", "email", "instagram"].includes(def.key)
      ? String(value ?? "")
      : fieldText(value, def, catalog);
  return text ? <span className={s.text}>{text}</span> : <span className={s.empty}>—</span>;
}
