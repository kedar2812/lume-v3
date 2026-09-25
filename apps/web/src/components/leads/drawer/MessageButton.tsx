"use client";
import { useEffect, useId, useState } from "react";
import b from "@/components/ui/Button.module.css";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { leadsClient } from "@/lib/leads/client";
import type { Lead } from "@/lib/leads/types";
import s from "./drawer.module.css";

/** Why WhatsApp can't open for this lead, or null when it can. */
export function whatsappBlocked(lead: Lead): string | null {
  const status = lead.phone?.status ?? "missing";
  if (status === "valid") return null;
  if (status === "needs_country") return "This number needs a country code";
  return "No WhatsApp number";
}

/**
 * The click-to-send hand-off (report §11.2). The link is built by the server and opened in a new tab
 * straight away; it is never shown. The tab is opened blank on the click itself and pointed at the link
 * once it arrives, because browsers block a new tab opened after waiting for the network. When the
 * person comes back to LUME, a quiet prompt asks whether it was sent.
 */
export function MessageButton({ lead, onLogged }: { lead: Lead; onLogged: () => void }) {
  const blocked = whatsappBlocked(lead);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState(false);
  const [asking, setAsking] = useState(false);
  const textId = useId();

  // "Sent?" appears the next time LUME has focus again after WhatsApp was opened.
  useEffect(() => {
    if (!awaiting) return;
    const back = () => {
      setAwaiting(false);
      setAsking(true);
    };
    window.addEventListener("focus", back, { once: true });
    return () => window.removeEventListener("focus", back);
  }, [awaiting]);

  const open = async (close: () => void) => {
    setError(null);
    const tab = window.open("", "_blank");
    if (!tab) return setError("Your browser blocked the new tab. Allow pop-ups for LUME, then try again.");
    tab.opener = null;
    const r = await leadsClient.prepareMessage(lead.id, text.trim());
    if (!r.ok) {
      tab.close();
      return setError(r.message);
    }
    tab.location.href = r.data.url;
    setText("");
    close();
    setAwaiting(true);
    onLogged();
  };

  const answer = async (sent: boolean) => {
    setAsking(false);
    await leadsClient.confirmMessage(lead.id, sent);
    onLogged();
  };

  return (
    <div className={s.message} data-whatsapp>
      <Popover
        label="WhatsApp message"
        triggerClassName={`${b.btn} ${b.whatsapp}`}
        disabled={!!blocked}
        trigger={
          <>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
              <path
                d="M8 1.8a6.2 6.2 0 0 0-5.3 9.4L2 14l2.9-.7A6.2 6.2 0 1 0 8 1.8z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            WhatsApp
          </>
        }
      >
        {(close) => (
          <form
            method="post"
            className={s.popForm}
            onSubmit={(e) => {
              e.preventDefault();
              void open(close);
            }}
          >
            <label htmlFor={textId} className={s.popLabel}>
              Message (optional)
            </label>
            <textarea
              id={textId}
              rows={4}
              maxLength={4096}
              className={s.popText}
              value={text}
              placeholder={`Hi ${(lead.name ?? "").split(" ")[0]},`}
              onChange={(e) => setText(e.target.value)}
            />
            {error && (
              <p role="alert" className={s.popError}>
                {error}
              </p>
            )}
            <Button type="submit" variant="whatsapp" className={s.popPrimary}>
              Open WhatsApp
            </Button>
          </form>
        )}
      </Popover>
      {blocked && <p className={s.why}>{blocked}</p>}
      {asking && (
        <div className={s.sent} role="group" aria-label="Was the WhatsApp message sent?">
          <span>Sent?</span>
          <Button size="sm" variant="primary" onClick={() => void answer(true)}>
            Yes, sent
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void answer(false)}>
            Not sent
          </Button>
        </div>
      )}
    </div>
  );
}
