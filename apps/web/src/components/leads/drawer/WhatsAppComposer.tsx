"use client";
import { bytesText } from "@lume/core/shared";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "@/components/ui/Popover";
import { FilePicker } from "@/components/whatsapp/FilePicker";
import { TemplatePick } from "@/components/whatsapp/TemplatePick";
import { addDays, dayKey, longDate, timeOf } from "@/lib/dates";
import type { LibraryFile } from "@/lib/files/client";
import { fileTypeWord } from "@/lib/files/words";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaAttached, WaReply, WaThreadMessage } from "@/lib/whatsapp/types";
import s from "./whatsapp.module.css";

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
/** What a person may attach, as WhatsApp takes it (the server checks the bytes either way). */
const ACCEPT =
  "image/jpeg,image/png,video/mp4,video/3gpp,audio/ogg,audio/mpeg,audio/mp4,audio/aac,audio/amr,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt";
const typeWord = (f: WaAttached) => fileTypeWord({ ...f, name: f.filename });

const Clip = () => (
  <svg
    aria-hidden="true"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 11.5 12.6 19.9a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
  </svg>
);

/**
 * Attach's menu (W3b-1 Task 4): this device, or the business's files. Mounted with the panel, so it opens on the menu
 * every time.
 */
function AttachMenu({ onDevice, onPick }: { onDevice(): void; onPick(f: LibraryFile): void }) {
  const [files, setFiles] = useState(false);
  if (files) return <FilePicker onPick={onPick} />;
  return (
    <div role="menu" aria-label="Attach from" className={s.menu}>
      <button type="button" role="menuitem" className={s.menuItem} onClick={onDevice}>
        From this device
      </button>
      <button type="button" role="menuitem" className={s.menuItem} onClick={() => setFiles(true)}>
        From your files
      </button>
    </div>
  );
}

/** "until 4:12 pm", "until 10:20 am tomorrow", or the date for anything later. */
function untilWords(iso: string, tz: string): string {
  const at = new Date(iso);
  const day = dayKey(at, tz);
  const today = dayKey(new Date(), tz);
  if (day === today) return `until ${timeOf(at, tz)}`;
  if (day === addDays(today, 1)) return `until ${timeOf(at, tz)} tomorrow`;
  return `until ${longDate(at, tz)}, ${timeOf(at, tz)}`;
}

/**
 * The reply box on a lead's WhatsApp tab (plan W3a; spec 2026-10-18 §3.4; canvas boards Main, Attached, Closed). Says
 * until when a reply may go and from which number; Enter sends on a computer (Shift+Enter for a new line), the Send
 * button on a phone. One message, however many taps: each message has its own key, kept until LUME has it, so a send
 * tried again after a dropped connection is the same message. After WhatsApp's 24 hours, the reason and the usual way
 * to open WhatsApp (`fallback`) instead of a box.
 */
export function WhatsAppComposer({
  leadId,
  leadName,
  tz,
  reply,
  taskId,
  onSent,
  fallback,
  library = false,
}: {
  leadId: string;
  leadName: string;
  tz: string;
  reply: NonNullable<WaReply>;
  /** The follow-up it's sent from: done once WhatsApp takes the message. */
  taskId?: string;
  onSent(m: WaThreadMessage): void;
  fallback?: ReactNode;
  /** This person may use the business's files (templates.use): Attach offers them beside this device. */
  library?: boolean;
}) {
  const who = first(leadName);
  const [text, setText] = useState("");
  const [file, setFile] = useState<WaAttached | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const [sending, setSending] = useState(false);
  const key = useRef(crypto.randomUUID());
  const coarse = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const device = useRef<HTMLInputElement>(null);
  // Grows with the words, up to six lines, then scrolls (every browser, not only those with field-sizing).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text, file]);
  useEffect(() => {
    coarse.current =
      typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
  }, []);

  if (!reply.allowed)
    return (
      <section className={s.composerClosed} aria-label={`Reply to ${who}`}>
        <p>{reply.reason}</p>
        {/* Outside the 24 hours an approved template can still go (W3b-2). */}
        <TemplatePick leadId={leadId} leadName={leadName} onSent={onSent} />
        {fallback}
      </section>
    );

  const n = reply.number!;
  const from = n.ownerName ? `${n.ownerName}'s number, ${n.display}` : n.display;
  const canSend = !sending && !attaching && (!!file || text.trim().length > 0);

  const send = async () => {
    if (busy.current || !canSend) return;
    busy.current = true;
    setSending(true);
    setError(null);
    const r = await whatsappClient.send(leadId, {
      clientKey: key.current,
      ...(text ? { text } : {}),
      ...(file ? { mediaId: file.id } : {}),
      ...(taskId ? { taskId } : {}),
    });
    busy.current = false;
    setSending(false);
    // Not taken: the words and the file stay, and so does the key, so trying again is the same message.
    if (!r.ok) return setError(r.message);
    key.current = crypto.randomUUID();
    setText("");
    setFile(null);
    onSent(r.data.message);
  };
  const attach = async (f: File | undefined) => {
    if (!f) return;
    setAttaching(f.name);
    setError(null);
    const r = await whatsappClient.attach(leadId, f);
    setAttaching(null);
    if (!r.ok) return setError(r.message);
    setFile({ ...r.data.media, filename: r.data.media.filename ?? f.name });
  };
  const attachKept = async (f: LibraryFile) => {
    setAttaching(f.name);
    setError(null);
    const r = await whatsappClient.attachFromLibrary(leadId, f.id);
    setAttaching(null);
    if (!r.ok) return setError(r.message);
    setFile(r.data.media);
  };
  const deviceInput = (
    <input
      ref={device}
      type="file"
      accept={ACCEPT}
      aria-label="Attach a photo or a file"
      className={s.srOnly}
      // Behind the menu's "From this device" when there is a menu: it opens the chooser, this takes the file. Out of
      // the tab order and hidden from screen readers then, so they hear one Attach, not two.
      tabIndex={library ? -1 : undefined}
      aria-hidden={library || undefined}
      disabled={!!attaching || sending}
      onChange={(e) => {
        void attach(e.target.files?.[0]);
        e.target.value = "";
      }}
    />
  );
  const label = file ? "Words with the file" : `Message to ${who}`;

  return (
    <form
      className={s.composer}
      aria-label={`Reply to ${who} on WhatsApp`}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <p className={s.window}>
        You can reply {reply.until ? untilWords(reply.until, tz) : "now"} · From {from}
      </p>
      {attaching && (
        <div className={s.attached} data-busy role="status">
          <span className={s.attachedText}>
            <span className={s.attachedName}>{attaching}</span>
            <span className={s.attachedMeta}>Attaching…</span>
          </span>
          <span className={s.attachedBar} aria-hidden />
        </div>
      )}
      {file && (
        <div className={s.attached}>
          <span className={s.attachedType} aria-hidden>
            {typeWord(file)}
          </span>
          <span className={s.attachedText}>
            <span className={s.attachedName}>{file.filename ?? "Photo"}</span>
            <span className={s.attachedMeta}>
              {typeWord(file)} · {bytesText(file.size)}
            </span>
          </span>
          <button
            type="button"
            className={s.iconButton}
            aria-label={`Remove ${file.filename ?? "the photo"}`}
            onClick={() => setFile(null)}
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className={s.composerError}>
          {error}
        </p>
      )}
      <div className={s.composerRow}>
        {library ? (
          <>
            {deviceInput}
            <Popover
              label="Attach"
              side="above"
              triggerLabel="Attach"
              triggerClassName={s.attachButton}
              trigger={<Clip />}
              disabled={!!attaching || sending}
            >
              {(close) => (
                <AttachMenu
                  onDevice={() => {
                    close();
                    device.current?.click();
                  }}
                  onPick={(f) => {
                    close();
                    void attachKept(f);
                  }}
                />
              )}
            </Popover>
          </>
        ) : (
          <label className={s.attachButton} data-busy={attaching ? true : undefined}>
            {deviceInput}
            <Clip />
          </label>
        )}
        <textarea
          ref={box}
          className={s.input}
          aria-label={label}
          placeholder={file ? "Add words with the file…" : `Write to ${who}…`}
          rows={1}
          value={text}
          maxLength={file ? 1024 : 4096}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // A computer: Enter sends, Shift+Enter is a new line. A phone keeps Enter for new lines.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !coarse.current) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" className={s.send} disabled={!canSend} data-sending={sending || undefined}>
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12h13M13 6l6 6-6 6" />
          </svg>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      <p className={s.hintLine}>Enter sends · Shift+Enter for a new line · It shows on the phone too</p>
    </form>
  );
}
