"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import { WhatsAppIcon } from "@/components/ui/WhatsAppIcon";
import { instagramClient } from "@/lib/instagram/client";
import { whatsappClient } from "@/lib/whatsapp/client";
import s from "./notyet.module.css";

/**
 * On Leads: "Not a lead yet · 3" while anyone is waiting (spec 2026-10-18 §4.1), on WhatsApp or Instagram (plan
 * 2026-11-25-instagram-screens D5); nothing otherwise. Instagram's count is its first page: "100+" past that.
 */
export function NotYetLink() {
  const [count, setCount] = useState<{ wa: number; ig: number }>({ wa: 0, ig: 0 });
  useEffect(() => {
    let live = true;
    void Promise.all([whatsappClient.inbox(), instagramClient.inbox()]).then(([w, i]) => {
      if (live) setCount({ wa: w.ok ? w.data.people.length : 0, ig: i.ok ? i.data.people.length : 0 });
    });
    return () => {
      live = false;
    };
  }, []);
  const n = count.wa + count.ig;
  if (!n) return null;
  const Arriving = UI_ICONS.arriving;
  return (
    <Link href="/leads/not-yet" className={s.link}>
      {count.ig === 0 ? (
        <WhatsAppIcon size={16} className={s.linkIcon} />
      ) : count.wa === 0 ? (
        <img src="/brand/instagram.png" alt="" width={16} height={16} className={s.linkIcon} />
      ) : (
        <Arriving size={ICON_SIZE.md} className={s.linkIcon} aria-hidden />
      )}
      Not a lead yet · {count.ig >= 100 ? `${n}+` : n}
    </Link>
  );
}
