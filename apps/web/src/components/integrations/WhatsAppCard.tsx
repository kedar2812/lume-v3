"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePlan } from "@/components/licence/LicenceProvider";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Switch } from "@/components/ui/Switch";
import { shortDate } from "@/lib/dates";
import type { IntegrationsView } from "@/lib/sheets/types";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaNumber } from "@/lib/whatsapp/types";
import { NOT_IN_PLAN_NOTE, NotInPlanPill, inPlan } from "./NotInPlan";
import { WhatsAppKeep } from "./WhatsAppKeep";
import s from "./integrations.module.css";

type WaView = NonNullable<IntegrationsView["whatsapp"]>;
const BUSINESS = "";
const TZ = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Before anything happens (spec 2026-10-18 §3.2): what connecting changes on the phone, said plainly. */
function ConnectSheet({ onClose }: { onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    const r = await whatsappClient.connect();
    if (!r.ok) {
      setBusy(false);
      return setError(r.message);
    }
    window.location.assign(r.data.url);
  };
  return (
    <Dialog label="Connect a WhatsApp number" onClose={onClose} wide>
      <div className={s.waSheet}>
        <div className={s.waSheetHead}>
          <span className={s.brandTile} aria-hidden>
            <img src="/brand/whatsapp.svg" alt="" width={24} height={24} />
          </span>
          <h2 className={s.waSheetTitle}>Connect a WhatsApp number</h2>
        </div>
        <p className={s.waSheetText}>
          You’ll log in to Facebook, pick your WhatsApp Business app number, and scan a code with the phone
          that runs it. Your chats stay on your phone too.
        </p>
        <div className={s.waChanges} role="group" aria-labelledby="wa-changes">
          <p id="wa-changes" className={s.waChangesHead}>
            What changes on the phone
          </p>
          <p>Broadcast lists stop working in the app.</p>
          <p>The WhatsApp app for Windows stops working. Use WhatsApp Web on a computer instead.</p>
          <p>Open WhatsApp on the phone at least once every 13 days, or the connection pauses.</p>
        </div>
        <p className={s.waSheetText}>
          Messages pass through LUME’s relay on their way to your LUME. They’re never stored there.
        </p>
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <div className={s.waSheetFoot}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void go()}>
            Continue with Facebook
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Settings → Integrations → WhatsApp (spec 2026-10-18 §3.2; canvas board Main): the switch, the numbers connected and
 * whose each is, and connecting another — with what changes on the phone said before anything happens.
 */
export function WhatsAppCard({ wa, onView }: { wa: WaView; onView(v: IntegrationsView): void }) {
  const out = !inPlan(usePlan(), "whatsapp") || !wa.inPlan;
  const usable = wa.available && !out;
  const on = wa.enabled && usable;
  const [numbers, setNumbers] = useState<WaNumber[] | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [leaving, setLeaving] = useState<WaNumber | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [n, p] = await Promise.all([whatsappClient.numbers(), whatsappClient.people()]);
    if (n.ok) setNumbers(n.data.numbers);
    if (p.ok) setPeople(p.data.people.filter((x) => x.active));
  }, []);
  useEffect(() => {
    if (on) void load();
    else setNumbers(null);
  }, [on, load]);

  const toggle = async (enabled: boolean) => {
    setError(null);
    const r = await whatsappClient.setEnabled(enabled);
    if (!r.ok) return setError(r.message);
    onView(r.data);
  };
  const setOwner = async (n: WaNumber, ownerId: string) => {
    setError(null);
    const r = await whatsappClient.setOwner(n.id, ownerId === BUSINESS ? null : ownerId);
    if (!r.ok) return setError(r.message);
    setNumbers(r.data.numbers);
  };
  const disconnect = async (n: WaNumber) => {
    setError(null);
    const r = await whatsappClient.disconnect(n.id);
    setLeaving(null);
    if (!r.ok) return setError(r.message);
    setNumbers(r.data.numbers);
  };

  return (
    <article className={s.card} aria-labelledby="wa-title">
      <header className={s.cardHead}>
        <span className={s.brandTile} aria-hidden>
          <img src="/brand/whatsapp.svg" alt="" width={26} height={26} />
        </span>
        <div className={s.cardText}>
          <h2 id="wa-title" className={s.cardTitle}>
            WhatsApp
            {out && <NotInPlanPill />}
          </h2>
          <p className={s.cardLede}>
            {out
              ? NOT_IN_PLAN_NOTE
              : !wa.available
                ? "WhatsApp comes through LUME’s relay, which isn’t set up on this server yet."
                : numbers?.length
                  ? `${numbers.length} ${numbers.length === 1 ? "number" : "numbers"} connected`
                  : "Replies, and messages you send from your phone, land on the lead by themselves."}
          </p>
        </div>
        <Switch
          checked={on}
          onChange={(v) => void toggle(v)}
          label={
            out
              ? "WhatsApp, not in this LUME’s plan"
              : !wa.available
                ? "WhatsApp, not set up here"
                : "WhatsApp"
          }
          labelHidden
          disabled={!usable}
        />
      </header>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {usable && !on && (
        <p className={s.waNote}>
          Works with your WhatsApp Business app number: keep using the app on your phone as you do now. LUME
          keeps chats with your leads only. Strangers wait in Not a lead yet for 14 days.
        </p>
      )}
      {on && numbers && numbers.length === 0 && (
        <div className={s.waEmpty}>
          <p>No number connected yet.</p>
          <Button variant="primary" onClick={() => setConnecting(true)}>
            Connect a WhatsApp number
          </Button>
        </div>
      )}
      {on && numbers && numbers.length > 0 && (
        <>
          <ul className={s.waNumbers} aria-label="Connected numbers">
            {numbers.map((n) => (
              <li key={n.id} className={s.waNumber}>
                <div className={s.waRow}>
                  <div className={s.waWho}>
                    <span className={s.waDisplay}>{n.display}</span>
                    <span className={s.waMeta} data-volatile>
                      {[
                        n.name,
                        `Connected ${shortDate(new Date(n.connectedAt), TZ()).replace(/, \w+$/, "")}`,
                        n.historyShared ? "past chats shared" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  <label className={s.waOwner}>
                    <span>Whose number</span>
                    <select
                      aria-label={`Whose number is ${n.display}?`}
                      value={n.owner?.id ?? BUSINESS}
                      onChange={(e) => void setOwner(n, e.target.value)}
                    >
                      <option value={BUSINESS}>The business</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Disconnect ${n.display}`}
                    onClick={() => setLeaving(n)}
                  >
                    Disconnect
                  </Button>
                </div>
                {n.status === "needs_attention" && (
                  <div role="status" className={s.waAttention}>
                    <span>{n.problem ?? "This number needs connecting again."}</span>
                    <Button size="sm" onClick={() => setConnecting(true)}>
                      Connect again
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className={s.waFoot}>
            <Button onClick={() => setConnecting(true)}>Connect another number</Button>
            <Link href="/leads/not-yet" className={s.waLink}>
              Not a lead yet
            </Link>
          </div>
        </>
      )}
      {on && numbers && numbers.length > 0 && (
        <WhatsAppKeep months={wa.keepFilesMonths ?? null} onView={onView} />
      )}
      {connecting && <ConnectSheet onClose={() => setConnecting(false)} />}
      {leaving && (
        <Dialog label={`Disconnect ${leaving.display}?`} onClose={() => setLeaving(null)}>
          <div className={s.waSheet}>
            <h2 className={s.waSheetTitle}>Disconnect {leaving.display}?</h2>
            <p className={s.waSheetText}>
              LUME stops getting this number’s messages, and its Not a lead yet is cleared. What’s already on
              leads stays.
            </p>
            <div className={s.waSheetFoot}>
              <Button variant="ghost" onClick={() => setLeaving(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void disconnect(leaving)}>
                Disconnect
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </article>
  );
}
