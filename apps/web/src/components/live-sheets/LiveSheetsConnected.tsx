"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { liveSheetsClient } from "@/lib/live-sheets/client";
import s from "./live-sheets.module.css";

/**
 * Back from Google (spec 2026-11-14 §2.4): the relay's hand-back finished once, then the form again where it was, with
 * that Google account chosen. The hand-back is single-use: it leaves the address at once, so a reload never spends it
 * twice.
 */
export function LiveSheetsConnected() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const p = params.get("p");
    const sig = params.get("s");
    if (!p || !sig) return setError("This page is for coming back from Google. Start from Live sheets.");
    void (async () => {
      const r = await liveSheetsClient.connectComplete(p, sig);
      window.history.replaceState?.(null, "", window.location.pathname);
      if (!r.ok) return setError(r.message);
      router.replace(`/live-sheets?grant=${encodeURIComponent(r.data.grant.id)}`);
    })();
  }, [params, router]);
  return (
    <div className={s.lock} role={error ? "alert" : "status"} style={{ maxWidth: 520, margin: "0 auto" }}>
      <h2>{error ? "Google isn't connected" : "Connecting Google…"}</h2>
      <p>{error ?? "LUME is finishing the connection, then takes you back to your live sheet."}</p>
      {error && (
        <Button variant="secondary" onClick={() => router.replace("/live-sheets")}>
          Back to Live sheets
        </Button>
      )}
    </div>
  );
}
