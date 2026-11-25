"use client";
import { partsOf } from "@lume/core/shared";
import { useMemo } from "react";
import s from "./chat.module.css";

/** Who a name in a message is, for whoever reads it. */
export type NameOf = (t: "person" | "team", id: string) => string | null;

/** A message's words (2B, Task 2): names, bold, italic, code and links, and everything else as it was typed. */
export function Words({ body, nameOf, me }: { body: string; nameOf: NameOf; me: string }) {
  const parts = useMemo(() => partsOf(body), [body]);
  return (
    <>
      {parts.map((p, i) => {
        switch (p.t) {
          case "text":
            return <span key={i}>{p.s}</span>;
          case "bold":
            return <strong key={i}>{p.s}</strong>;
          case "italic":
            return <em key={i}>{p.s}</em>;
          case "code":
            return (
              <code key={i} className={s.code}>
                {p.s}
              </code>
            );
          case "link":
            return (
              <a key={i} className={s.link} href={p.href} target="_blank" rel="noopener noreferrer">
                {p.s}
              </a>
            );
          case "channel":
            return (
              <span key={i} className={s.mention} data-me="">
                @channel
              </span>
            );
          default:
            return (
              <span key={i} className={s.mention} data-me={p.t === "person" && p.id === me ? "" : undefined}>
                @{nameOf(p.t, p.id) ?? (p.t === "team" ? "a team" : "someone")}
              </span>
            );
        }
      })}
    </>
  );
}
