"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { instagramClient } from "@/lib/instagram/client";
import s from "./integrations.module.css";

const BACK = "/settings/integrations#instagram";

/**
 * The relay hands an Instagram account back here (`?p=&s=`, apps/connect/src/instagram.ts): finish it once, say which
 * account, and go back to its card. The hand-back is single use, so it leaves the address at once, also when it fails.
 */
export function InstagramConnected() {
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
        "This page is for coming back from Instagram. Start from Settings → Integrations → Instagram.",
      );
    void (async () => {
      const r = await instagramClient.complete({ p, s: sig });
      window.history.replaceState?.(null, "", window.location.pathname);
      if (!r.ok) return setError(r.message);
      const newest = [...r.data.accounts].sort((a, b) => b.connectedAt.localeCompare(a.connectedAt))[0];
      toast({
        tone: "ok",
        title: "Instagram connected",
        mark: { src: "/brand/instagram.png", alt: "" },
        ...(newest ? { detail: `@${newest.username}` } : {}),
      });
      router.replace(BACK);
    })();
  }, [params, router, toast]);

  if (!error)
    return (
      <p role="status" className={s.cardLede}>
        Finishing connecting your Instagram account…
      </p>
    );
  return (
    <div className={s.waSheet}>
      <p role="alert" className={s.error}>
        {error}
      </p>
      <Link href={BACK} className={s.waLink}>
        Back to Integrations
      </Link>
    </div>
  );
}
