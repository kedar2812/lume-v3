"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AddSheetSheet } from "@/components/sheets/AddSheetSheet";
import { Button } from "@/components/ui/Button";
import { sheetsClient } from "@/lib/sheets/client";
import s from "./integrations.module.css";

/** Back from Google (2B §6): finish the hand-back once, then connect the picked file with the usual steps. */
export function Connected() {
  const params = useSearchParams();
  const router = useRouter();
  const [picked, setPicked] = useState<{ connectId: string; file: { id: string; name: string } } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const p = params.get("p");
    const sig = params.get("s");
    if (!p || !sig)
      return setError("This page is for coming back from Google. Start from Settings → Integrations.");
    void sheetsClient.complete({ p, s: sig }).then((r) => {
      // The hand-back is single-use: take it out of the address so a reload doesn't try to spend it again.
      window.history.replaceState(null, "", window.location.pathname);
      if (!r.ok) return setError(r.message);
      if ("reconnected" in r.data) return router.replace(`/settings/integrations/${r.data.reconnected}`);
      setPicked(r.data);
    });
  }, [params, router]);
  const again = async () => {
    const r = await sheetsClient.connect();
    if (r.ok) window.location.assign(r.data.url);
  };
  return (
    <div className={s.detail}>
      {error && (
        <div className={s.attention}>
          <p role="alert">{error}</p>
          <Button variant="primary" onClick={() => void again()}>
            Try again
          </Button>
        </div>
      )}
      {!error && !picked && <p className={s.cardLede}>Connecting…</p>}
      <AddSheetSheet
        open={!!picked}
        {...(picked ? { connect: picked } : {})}
        onClose={(savedId) =>
          router.replace(savedId ? `/settings/integrations/${savedId}` : "/settings/integrations")
        }
      />
    </div>
  );
}
