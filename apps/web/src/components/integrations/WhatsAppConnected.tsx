"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { whatsappClient } from "@/lib/whatsapp/client";
import s from "./integrations.module.css";

/**
 * The relay hands a WhatsApp number back here (`?p=&s=`, spec 2026-10-18 §3.2): finish it once, say which number, and go
 * back to Integrations. The hand-back is single-use, so it leaves the address at once.
 */
export function WhatsAppConnected() {
  const params = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const p = params.get("p");
    const sig = params.get("s");
    if (!p || !sig)
      return setError(
        "This page is for coming back from Facebook. Start from Settings → Integrations → WhatsApp.",
      );
    void (async () => {
      const r = await whatsappClient.complete({ p, s: sig });
      window.history.replaceState?.(null, "", window.location.pathname);
      if (!r.ok) return setError(r.message);
      const newest = [...r.data.numbers].sort((a, b) => b.connectedAt.localeCompare(a.connectedAt))[0];
      toast({ tone: "ok", title: "WhatsApp connected", ...(newest ? { detail: newest.display } : {}) });
      router.replace("/settings/integrations");
    })();
  }, [params, router, toast]);

  if (!error)
    return (
      <p role="status" className={s.cardLede}>
        Finishing connecting your number…
      </p>
    );
  return (
    <div className={s.waSheet}>
      <p role="alert" className={s.error}>
        {error}
      </p>
      <Link href="/settings/integrations" className={s.waLink}>
        Back to Integrations
      </Link>
    </div>
  );
}
