"use client";
import { bytesText } from "@lume/core/shared";
import { useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { Switch } from "@/components/ui/Switch";
import { useZone } from "@/components/ZoneProvider";
import { filesClient, type LibraryFile } from "@/lib/files/client";
import { lengthText } from "@/lib/files/words";
import { settingsDate } from "@/lib/settings/format";
import v from "./viewer.module.css";

const opened = (n: number) => (n === 0 ? "Not opened yet" : n === 1 ? "Opened once" : `Opened ${n} times`);

/**
 * A file's Info (canvas Viewer, PhoneSheet): where it goes, its share link, what it is, and for an admin Rename and
 * Archive. Everything here explains itself, so nobody needs a call to learn it.
 */
export function InfoPanel({
  file: f,
  canManage,
  onChange,
  onRename,
  onArchive,
}: {
  file: LibraryFile;
  canManage: boolean;
  onChange(f: LibraryFile): void;
  onRename(): void;
  onArchive(): void;
}) {
  const tz = useZone();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [wentOff, setWentOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const thisYear = new Date().getFullYear() === new Date(f.createdAt).getFullYear();

  const setLink = async (on: boolean) => {
    setBusy(true);
    const r = await filesClient.setLink(f.id, on);
    setBusy(false);
    if (!r.ok) return toast({ tone: "danger", title: "The link didn't change", detail: r.message });
    setWentOff(!on);
    setCopied(false);
    onChange(r.data.file);
  };
  const copy = async () => {
    if (!f.link.url) return;
    try {
      await navigator.clipboard.writeText(f.link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (an old browser, a denied permission): the link is on the screen to copy by hand.
    }
  };
  const retry = async () => {
    setRetrying(true);
    const r = await filesClient.retryPreview(f.id);
    setRetrying(false);
    if (!r.ok) return toast({ tone: "danger", title: "LUME couldn't try again", detail: r.message });
    onChange(r.data.file);
  };

  return (
    <div className={v.info}>
      <section className={v.sec} aria-label="Where it goes">
        <span className={v.lbl}>Where it goes</span>
        <div className={v.where}>
          <img src="/brand/whatsapp-app.png" alt="" width={24} height={24} />
          <span>
            Sends as the real file from any lead&apos;s WhatsApp tab: Attach, then From Media. It can go at
            the top of a WhatsApp template too.
          </span>
        </div>
      </section>

      {(canManage || f.link.on) && (
        <section className={v.sec} aria-label="Share by link">
          <div className={v.shareHead}>
            <span className={v.shareWords}>
              <b>Share by link</b>
              <span>For someone not on WhatsApp. Switch it off and the link stops working at once.</span>
            </span>
            {canManage && (
              <Switch
                checked={f.link.on}
                label={`Share ${f.name} by link`}
                labelHidden
                disabled={busy}
                onChange={(on) => void setLink(on)}
              />
            )}
          </div>
          {f.link.on && f.link.url ? (
            <>
              <div className={v.linkRow}>
                <span className={v.url}>{f.link.url}</span>
                <button
                  type="button"
                  className={v.copy}
                  aria-label={`Copy the link to ${f.name}`}
                  data-copied={copied || undefined}
                  onClick={() => void copy()}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <span className={v.small}>{opened(f.link.opens)}</span>
            </>
          ) : (
            wentOff && <span className={v.small}>Anyone with the old link now sees nothing.</span>
          )}
        </section>
      )}

      <section className={v.sec} aria-label="About this file">
        <span className={v.lbl}>About</span>
        <div className={v.row}>
          <span>Added</span>
          <span>{settingsDate(f.createdAt, tz, !thisYear)}</span>
        </div>
        {f.pages !== null && (
          <div className={v.row}>
            <span>
              {f.mime.includes("presentation") || f.mime.includes("powerpoint") ? "Slides" : "Pages"}
            </span>
            <span>{f.pages}</span>
          </div>
        )}
        {f.durationMs !== null && (
          <div className={v.row}>
            <span>Length</span>
            <span>{lengthText(f.durationMs)}</span>
          </div>
        )}
        {f.width !== null && f.height !== null && (f.viewAs === "image" || f.viewAs === "video") && (
          <div className={v.row}>
            <span>Size in pixels</span>
            <span>
              {f.width} × {f.height}
            </span>
          </div>
        )}
        <div className={v.row}>
          <span>Size</span>
          <span>{bytesText(f.size)}</span>
        </div>
        {f.preview === "failed" && (
          <div className={v.failed}>
            <span>LUME couldn&apos;t make a preview of this file. It still sends as it is.</span>
            {canManage && (
              <button type="button" className={v.link} onClick={() => void retry()} disabled={retrying}>
                {retrying ? "Trying…" : "Try again"}
              </button>
            )}
          </div>
        )}
      </section>

      {canManage && (
        <div className={v.actions}>
          <button type="button" className={v.action} onClick={onRename}>
            Rename
          </button>
          <button type="button" className={v.action} data-tone="danger" onClick={onArchive}>
            Archive
          </button>
        </div>
      )}
    </div>
  );
}
