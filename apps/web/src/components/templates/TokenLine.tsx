import { Fragment } from "react";
import { VARIABLES, waFormat, type FieldType } from "@lume/core/shared";
import s from "./templates.module.css";

const TOKEN = /(\{\{[^{}]+\}\})/g;
/** A variable nobody named (a field since archived): its key, in words. */
const humanize = (token: string) => {
  const key = token.split(".").at(-1) ?? token;
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * A template's words as a person reads them in a list: each {{variable}} is a small chip with its name
 * ("First name"), so nobody has to read code to know which template is which.
 */
export function TokenLine({
  text,
  fields,
}: {
  text: string;
  fields: { key: string; type: FieldType; label?: string }[];
}) {
  const labels = new Map(VARIABLES(fields).map((v) => [v.token, v.label]));
  const words = (run: string) =>
    run.split(TOKEN).map((part, i) => {
      const m = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(part);
      if (!m) return <Fragment key={i}>{part}</Fragment>;
      return (
        <span key={i} className={s.token} data-token={m[1]}>
          {labels.get(m[1]!) ?? humanize(m[1]!)}
        </span>
      );
    });
  // *bold* and _italic_ as WhatsApp shows them, never as the marks that make them.
  return (
    <>
      {waFormat(text).map((r, i) =>
        r.b ? (
          <strong key={i}>{words(r.t)}</strong>
        ) : r.i ? (
          <em key={i}>{words(r.t)}</em>
        ) : (
          <Fragment key={i}>{words(r.t)}</Fragment>
        ),
      )}
    </>
  );
}
