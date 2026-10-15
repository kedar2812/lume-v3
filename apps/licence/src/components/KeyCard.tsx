"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { day } from "@/lib/format";
import { clientMessage } from "@/lib/message";
import type { ClientView } from "@/server/clients";
import { HoldButton } from "./HoldButton";

type Answer = { client: ClientView; licenseKey?: string } | null;
type Status = ClientView["activation"]["status"];

const PILL: Record<Status, { label: string; cls: string }> = {
  active: { label: "Active", cls: "active" },
  not_activated: { label: "Not activated", cls: "waiting" },
  released: { label: "Released", cls: "grace" },
  decommissioned: { label: "Decommissioned", cls: "suspended" },
};
const ICON_BG: Record<Status, string> = {
  active: "#18a566",
  not_activated: "#9aa0ab",
  released: "#f2a20c",
  decommissioned: "#e5484d",
};

/**
 * A client's Licence key (spec 2026-10-15 §3.2, canvas DashClient): where the key is, Show and Copy, the message
 * for the client, Rotate (decommissions the old key) and Release behind inline confirms, and Hold to decommission.
 * After Rotate or Issue a new key, the new key types itself out once.
 */
export function KeyCard({
  c,
  gone,
  busy,
  refused,
  run,
}: {
  c: ClientView;
  /** The client is decommissioned: its record stays, nothing changes it. */
  gone: boolean;
  busy: boolean;
  /** The newest refused try from another server this week, if any. */
  refused: { at: string; ip: string | null } | null;
  /** One admin action: the page refreshes from its answer and says what happened. */
  run: (path: string, words: string) => Promise<Answer>;
}) {
  const status = c.activation.status;
  const [shown, setShown] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ key: string; words: string } | null>(null);
  const [typed, setTyped] = useState(0);
  const [copied, setCopied] = useState<"key" | "message" | null>(null);
  const [ask, setAsk] = useState<"rotate" | "release" | null>(null);
  const typing = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => () => clearInterval(typing.current), []);

  const typingNow = fresh !== null && typed < fresh.key.length;
  const visible = fresh?.key ?? shown;
  const copy = (text: string, what: "key" | "message") => {
    void navigator.clipboard?.writeText(text);
    setCopied(what);
  };
  const typeOut = (key: string, words: string) => {
    setFresh({ key, words });
    setShown(null);
    setCopied(null);
    setTyped(0);
    clearInterval(typing.current);
    typing.current = setInterval(() => {
      setTyped((n) => {
        if (n + 1 >= key.length) clearInterval(typing.current);
        return n + 1;
      });
    }, 38);
  };
  const keyNow = async (): Promise<string | null> => {
    if (visible) return visible;
    const r = await api.get<{ licenseKey: string }>(`/api/clients/${c.id}/key`);
    return r.ok ? r.data.licenseKey : null;
  };

  const show = async () => {
    if (shown) return setShown(null);
    const key = await keyNow();
    if (key) setShown(key);
  };
  const copyMessage = async () => {
    const key = await keyNow();
    if (key) copy(clientMessage(c.slug, key), "message");
  };
  const rotate = async () => {
    setAsk(null);
    const r = await run(`/api/clients/${c.id}/rotate`, "New key made · the old one is decommissioned");
    if (r?.licenseKey)
      typeOut(
        r.licenseKey,
        `The old key is decommissioned. ${c.name}'s server keeps working on it for 7 days: send them the new one.`,
      );
  };
  const release = async () => {
    setAsk(null);
    await run(`/api/clients/${c.id}/release`, "Released · the next server to enter the key takes it");
  };
  const decommission = async () =>
    (await run(`/api/clients/${c.id}/key/decommission`, "Key decommissioned · it works nowhere now")) !==
    null;
  const issue = async () => {
    const r = await run(`/api/clients/${c.id}/key/issue`, "A new key, ready to send");
    if (r?.licenseKey)
      typeOut(r.licenseKey, "A fresh key, not activated yet. Send it with Copy message for client.");
  };

  const pill = PILL[status];
  const title =
    status === "active"
      ? `Active on ${c.activation.ip ?? "its server"}`
      : status === "not_activated"
        ? "Not activated yet"
        : status === "released"
          ? "Released — the next server to enter it takes it"
          : "Key decommissioned";
  const sub =
    status === "active"
      ? `Since ${c.activation.at ? day(c.activation.at.slice(0, 10)) : "its first check-in"}. It checks in every 6 hours from this server.`
      : status === "not_activated"
        ? `Waiting for ${c.name} to enter it.`
        : status === "released"
          ? "Only a key entered by hand takes it now."
          : `It works nowhere. ${c.name}'s LUME pauses at its next check-in; export still works there.`;

  return (
    <section className="card keycard" aria-label="Licence key" style={{ animationDelay: ".1s" }}>
      <div className="keyhead">
        <h2 className="h">Licence key</h2>
        <span className={`pill ${pill.cls}`}>
          <i />
          {pill.label}
        </span>
      </div>

      <div className="keystatus">
        <span className="kico" style={{ background: ICON_BG[status] }} aria-hidden>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="12" rx="2.5" />
            <path d="M8 20h8M12 16v4" />
          </svg>
        </span>
        <span className="kwords">
          <strong>{title}</strong>
          <span>{sub}</span>
        </span>
      </div>

      {refused && status !== "decommissioned" && (
        <div className="keyalert" role="alert">
          <strong>Tried on another server</strong> — {refused.ip ?? "another address"},{" "}
          {day(refused.at.slice(0, 10))}. It was refused. If {c.name} is moving servers, release the key; if
          not, rotate it.
        </div>
      )}

      {status !== "decommissioned" && (
        <div className="keybox">
          <span className="mono" style={{ flexGrow: 1, overflowWrap: "anywhere" }}>
            {fresh ? fresh.key.slice(0, typed) : (shown ?? c.keyMasked)}
            {typingNow && <span className="caret" aria-hidden />}
          </span>
          {!fresh && c.keyShowable && (
            <button
              type="button"
              className="btn second small tight"
              aria-pressed={shown !== null}
              onClick={() => void show()}
            >
              {shown ? "Hide" : "Show"}
            </button>
          )}
          {visible && !typingNow && (
            <button type="button" className="btn second small tight" onClick={() => copy(visible, "key")}>
              {copied === "key" ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      )}
      {fresh && !typingNow && <span className="knote">{fresh.words}</span>}

      {!gone && status !== "decommissioned" && (
        <div className="keyacts">
          {(c.keyShowable || fresh) && (
            <button type="button" className="btn second" onClick={() => void copyMessage()}>
              {copied === "message" ? "Copied" : "Copy message for client"}
            </button>
          )}
          <button
            type="button"
            className="btn second"
            disabled={busy || typingNow}
            onClick={() => setAsk(ask === "rotate" ? null : "rotate")}
          >
            Rotate key
          </button>
          {status === "active" && (
            <button
              type="button"
              className="btn amber"
              disabled={busy}
              onClick={() => setAsk(ask === "release" ? null : "release")}
            >
              Release key
            </button>
          )}
        </div>
      )}

      {ask === "rotate" && (
        <div className="confirm blue reveal" role="group" aria-label="Rotate the key?">
          <span>
            <strong>Rotate the key?</strong> A new key replaces this one at once, and the old key is{" "}
            <strong className="red">decommissioned</strong>: it works nowhere, ever again. {c.name} keeps its
            server and enters the new key in Settings → About.
          </span>
          <span className="cbtns">
            <button type="button" className="btn primary small" disabled={busy} onClick={() => void rotate()}>
              Rotate key
            </button>
            <button type="button" className="btn second small" onClick={() => setAsk(null)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {ask === "release" && (
        <div
          className="confirm amber reveal"
          role="group"
          aria-label={`Release from ${c.activation.ip ?? "its server"}?`}
        >
          <span>
            <strong>Release from {c.activation.ip ?? "its server"}?</strong> The next server to enter this key
            takes it. This server is no longer accepted from its next check-in, so do it when {c.name} is
            ready to move.
          </span>
          <span className="cbtns">
            <button
              type="button"
              className="btn amber-solid small"
              disabled={busy}
              onClick={() => void release()}
            >
              Release key
            </button>
            <button type="button" className="btn second small" onClick={() => setAsk(null)}>
              Cancel
            </button>
          </span>
        </div>
      )}

      {!gone && status !== "decommissioned" && (
        <>
          <span className="knote">
            One key, one server. Rotate gives a new key on the same server and decommissions the old one;
            Release frees the key for a new server.
          </span>
          <div className="holdwrap">
            <HoldButton
              label="Hold to decommission key"
              busyLabel="Keep holding…"
              onDone={decommission}
              describedBy={`hold-${c.id}`}
            />
            <span id={`hold-${c.id}`} className="knote">
              Hold for a second and a half. The key stops working everywhere, for good, and the LUME using it
              pauses at its next check-in. Export still works there.
            </span>
          </div>
        </>
      )}

      {!gone && status === "decommissioned" && !fresh && (
        <div className="confirm red reveal">
          <span>
            <strong className="red">Key decommissioned.</strong> It can&apos;t be activated or checked in
            anywhere again.
          </span>
          <span className="cbtns">
            <button type="button" className="btn primary small" disabled={busy} onClick={() => void issue()}>
              Issue a new key
            </button>
          </span>
        </div>
      )}
    </section>
  );
}
