"use client";
import { WhatsAppIcon } from "@/components/ui/WhatsAppIcon";
import Link from "next/link";
import { useEffect, useState } from "react";
import { whatsappClient } from "@/lib/whatsapp/client";
import s from "./notyet.module.css";

/** On Leads: "Not a lead yet · 3" while anyone is waiting (spec 2026-10-18 §4.1); nothing otherwise. */
export function NotYetLink() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    void whatsappClient.inbox().then((r) => live && r.ok && setCount(r.data.people.length));
    return () => {
      live = false;
    };
  }, []);
  if (!count) return null;
  return (
    <Link href="/leads/not-yet" className={s.link}>
      <WhatsAppIcon size={16} className={s.linkIcon} />
      Not a lead yet · {count}
    </Link>
  );
}
