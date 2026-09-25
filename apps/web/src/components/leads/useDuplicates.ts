"use client";
import { useEffect, useRef, useState } from "react";
import { leadsClient } from "@/lib/leads/client";
import type { Duplicate } from "@/lib/leads/types";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Duplicate warnings while a lead is typed in (report §8.3). It waits for a pause, asks only once a phone
 * or email is complete enough to match, and shows only the answer to the latest input.
 */
export function useDuplicates(c: { phone?: string; email?: string }): Duplicate[] {
  const [found, setFound] = useState<Duplicate[]>([]);
  const latest = useRef(0);
  const phone = c.phone?.replace(/\s/g, "") ?? "";
  const email = c.email?.trim() ?? "";

  useEffect(() => {
    const n = ++latest.current; // any answer still on its way is now out of date
    const phoneOk = phone.replace(/\D/g, "").length >= 7;
    const emailOk = EMAIL.test(email);
    if (!phoneOk && !emailOk) {
      setFound([]);
      return;
    }
    const t = setTimeout(async () => {
      const r = await leadsClient.duplicates({
        ...(phoneOk ? { phone } : {}),
        ...(emailOk ? { email } : {}),
      });
      if (n === latest.current) setFound(r.ok ? r.data.duplicates : []);
    }, 400);
    return () => clearTimeout(t);
  }, [phone, email]);

  return found;
}
