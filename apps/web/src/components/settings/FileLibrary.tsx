"use client";
import { bytesText } from "@lume/core/shared";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useZone } from "@/components/ZoneProvider";
import { filesClient, type LibraryFile } from "@/lib/files/client";
import { fileTypeWord } from "@/lib/files/words";
import { accessGone } from "@/lib/settings/access";
import { settingsDate } from "@/lib/settings/format";
import { AccessChanged } from "./AccessChanged";
import s from "./files.module.css";

/** What WhatsApp takes (the server reads the bytes either way). */
const ACCEPT =
  "image/jpeg,image/png,video/mp4,video/3gpp,audio/ogg,audio/mpeg,audio/mp4,audio/aac,audio/amr,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt";
const byName = (a: LibraryFile, b: LibraryFile) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
const typeOf = (f: LibraryFile) => fileTypeWord(f);
const opened = (n: number) => (n === 0 ? "Not opened yet" : n === 1 ? "Opened once" : `Opened ${n} times`);

type Upload = { key: string; name: string; problem: string | null };

/**
 * Settings → Files (plan W3b-1 Task 5): the business's brochures, price lists and photos, kept once and sent from any
 * lead. Drop or choose files; rename in place; share one by link (switched off, the old link shows nothing); archive
 * with Undo. Archived files stay on the server for the messages that already sent them.
 */
export function FileLibrary() {
  const tz = useZone();
  const { toast } = useToast();
  const [files, setFiles] = useState<LibraryFile[] | null>(null);
  const [state, setState] = useState<"ready" | "error" | "gone">("ready");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [archived, setArchived] = useState<LibraryFile[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [over, setOver] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    void filesClient.list().then((r) => {
      if (r.ok) return setFiles(r.data.files);
      setState(accessGone(r) ? "gone" : "error");
    });
  }, []);

  const put = useCallback((f: LibraryFile) => {
    setFiles((xs) => [...(xs ?? []).filter((x) => x.id !== f.id), f].sort(byName));
  }, []);
  const drop = useCallback((id: string) => setFiles((xs) => (xs ?? []).filter((x) => x.id !== id)), []);

  const loadArchived = useCallback(async () => {
    const r = await filesClient.list(true);
    setArchived(r.ok ? r.data.files : []);
  }, []);

  const add = (chosen: File[]) =>
    chosen.forEach((f) => {
      const key = `u${++seq.current}`;
      setUploads((us) => [...us, { key, name: f.name, problem: null }]);
      void filesClient.upload(f).then((r) => {
        if (!r.ok)
          return setUploads((us) => us.map((u) => (u.key === key ? { ...u, problem: r.message } : u)));
        setUploads((us) => us.filter((u) => u.key !== key));
        put(r.data.file);
      });
    });

  const restore = async (f: LibraryFile) => {
    const r = await filesClient.restore(f.id);
    if (!r.ok) return toast({ tone: "danger", title: `${f.name} couldn't be put back`, detail: r.message });
    setArchived((xs) => xs && xs.filter((x) => x.id !== f.id));
    put(r.data.file);
  };
  const archive = async (f: LibraryFile) => {
    const r = await filesClient.archive(f.id);
    if (!r.ok) return toast({ tone: "danger", title: `${f.name} couldn't be archived`, detail: r.message });
    drop(f.id);
    if (showArchived) setArchived((xs) => [...(xs ?? []), r.data.file].sort(byName));
    toast({
      tone: "ok",
      title: `${f.name} archived`,
      detail: "Messages that already sent it keep it.",
      action: { label: "Undo", onClick: () => void restore(f) },
    });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    add(Array.from(e.dataTransfer?.files ?? []));
  };

  if (state === "gone") return <AccessChanged />;

  return (
    <div className={s.page}>
      <section
        className={s.drop}
        aria-label="Add files"
        data-over={over || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={onDrop}
      >
        <svg className={s.dropIcon} aria-hidden viewBox="0 0 24 24" width="22" height="22">
          <path
            d="M12 15V4m0 0-4 4m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <p className={s.dropTitle}>Drop brochures, price lists and photos here</p>
        <p className={s.dropHint}>Photos up to 5 MB, videos up to 16 MB, documents up to 25 MB.</p>
        <label className={s.choose}>
          <input
            type="file"
            multiple
            accept={ACCEPT}
            aria-label="Choose files"
            className={s.srOnly}
            onChange={(e) => {
              add(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          Choose files
        </label>
      </section>

      {state === "error" && (
        <p role="alert" className={s.problem}>
          LUME couldn&apos;t load your files just now. Reload the page to try again.
        </p>
      )}

      {files === null && state === "ready" ? (
        <section className={s.panel} aria-busy="true" aria-label="Loading your files">
          {[0, 1, 2].map((i) => (
            <div key={i} className={s.loadingRow}>
              <Skeleton width={36} height={36} radius={8} />
              <span className={s.loadingText}>
                <Skeleton width={i === 1 ? "36%" : "52%"} height={13} />
                <Skeleton width="28%" height={11} />
              </span>
            </div>
          ))}
        </section>
      ) : files !== null && files.length === 0 && uploads.length === 0 ? (
        <EmptyState
          title="No files yet"
          body="Add a brochure, price list or photo once, then send it from any lead's WhatsApp."
        />
      ) : (
        files !== null && (
          <section className={s.panel} aria-label="Your files">
            <ul className={s.list}>
              {uploads.map((u) => (
                <li
                  key={u.key}
                  className={s.row}
                  aria-label={`${u.name}, ${u.problem ? "not added" : "uploading"}`}
                  data-problem={u.problem ? true : undefined}
                >
                  <span className={s.type} aria-hidden>
                    {u.name.split(".").pop()?.toUpperCase().slice(0, 4) || "FILE"}
                  </span>
                  <span className={s.main}>
                    <span className={s.name}>{u.name}</span>
                    {u.problem ? (
                      <span className={s.refused}>{u.problem}</span>
                    ) : (
                      <span className={s.meta}>
                        Uploading…
                        <span className={s.bar} aria-hidden />
                      </span>
                    )}
                  </span>
                  {u.problem && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Dismiss ${u.name}`}
                      onClick={() => setUploads((us) => us.filter((x) => x.key !== u.key))}
                    >
                      Dismiss
                    </Button>
                  )}
                </li>
              ))}
              {files.map((f) => (
                <FileRow key={f.id} file={f} tz={tz} onChange={put} onArchive={() => void archive(f)} />
              ))}
            </ul>
          </section>
        )
      )}

      {files !== null && (
        <div className={s.archived}>
          <button
            type="button"
            className={s.archivedToggle}
            aria-expanded={showArchived}
            onClick={() => {
              const next = !showArchived;
              setShowArchived(next);
              if (next) void loadArchived();
            }}
          >
            {showArchived ? "Hide archived files" : "Show archived files"}
          </button>
          {showArchived &&
            (archived === null ? (
              <p className={s.muted}>Loading…</p>
            ) : archived.length === 0 ? (
              <p className={s.muted}>No archived files.</p>
            ) : (
              <ul className={s.list} aria-label="Archived files">
                {archived.map((f) => (
                  <li key={f.id} className={s.row} aria-label={`${f.name}, archived`}>
                    <span className={s.type} aria-hidden>
                      {typeOf(f)}
                    </span>
                    <span className={s.main}>
                      <span className={s.name}>{f.name}</span>
                      <span className={s.meta}>
                        {typeOf(f)} · {bytesText(f.size)}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Restore ${f.name}`}
                      onClick={() => void restore(f)}
                    >
                      Restore
                    </Button>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      )}
    </div>
  );
}

/** One file: its name (renamed in place), what it is, its share link, and Archive. */
function FileRow({
  file: f,
  tz,
  onChange,
  onArchive,
}: {
  file: LibraryFile;
  tz: string;
  onChange(f: LibraryFile): void;
  onArchive(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(f.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [wentOff, setWentOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const cancelled = useRef(false);
  const inFlight = useRef(false);
  const thisYear = new Date().getFullYear() === new Date(f.createdAt).getFullYear();

  const startRename = () => {
    cancelled.current = false;
    setDraft(f.name);
    setProblem(null);
    setEditing(true);
  };
  const save = async () => {
    const name = draft.trim();
    if (!name || name === f.name) {
      setProblem(null);
      return setEditing(false);
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    const r = await filesClient.rename(f.id, name);
    inFlight.current = false;
    setSaving(false);
    if (!r.ok) return setProblem(r.message);
    setProblem(null);
    setEditing(false);
    onChange(r.data.file);
  };
  const setLink = async (on: boolean) => {
    setLinkBusy(true);
    const r = await filesClient.setLink(f.id, on);
    setLinkBusy(false);
    if (!r.ok) return setProblem(r.message);
    setProblem(null);
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
      // No clipboard (an old browser, a denied permission): the link is on the page to copy by hand.
    }
  };

  return (
    <li className={s.row} aria-label={f.name}>
      <span className={s.type} data-kind={f.kind} aria-hidden>
        {typeOf(f)}
      </span>
      <span className={s.main}>
        {editing ? (
          <input
            className={s.rename}
            aria-label={`Name of ${f.name}`}
            value={draft}
            maxLength={120}
            autoFocus
            // Read-only while saving, not disabled: disabling the focused box would blur it and save twice.
            readOnly={saving}
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelled.current = true;
                setProblem(null);
                setEditing(false);
              }
            }}
            onBlur={() => {
              if (!cancelled.current && !problem) void save();
            }}
          />
        ) : (
          <span className={s.name}>{f.name}</span>
        )}
        <span className={s.meta}>
          {typeOf(f)} · {bytesText(f.size)} · Added {settingsDate(f.createdAt, tz, !thisYear)}
        </span>
        {problem && (
          <span role="alert" className={s.refused}>
            {problem}
          </span>
        )}
        {f.link.on && f.link.url ? (
          <span className={s.link}>
            <span className={s.url}>{f.link.url}</span>
            <button
              type="button"
              className={s.copy}
              aria-label={`Copy the link to ${f.name}`}
              data-copied={copied || undefined}
              onClick={() => void copy()}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <span className={s.opens}>{opened(f.link.opens)}</span>
          </span>
        ) : (
          wentOff && <span className={s.offNote}>Anyone with the old link now sees nothing.</span>
        )}
      </span>
      <span className={s.actions}>
        <span className={s.share}>
          <span aria-hidden className={s.shareWord}>
            Share by link
          </span>
          <Switch
            checked={f.link.on}
            label={`Share ${f.name} by link`}
            labelHidden
            disabled={linkBusy}
            onChange={(on) => void setLink(on)}
          />
        </span>
        <button
          type="button"
          className={s.iconBtn}
          aria-label={`Rename ${f.name}`}
          onClick={startRename}
          disabled={editing}
        >
          <svg aria-hidden viewBox="0 0 24 24" width="16" height="16">
            <path
              d="M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button type="button" className={s.iconBtn} aria-label={`Archive ${f.name}`} onClick={onArchive}>
          <svg aria-hidden viewBox="0 0 24 24" width="16" height="16">
            <path
              d="M4 7h16M5 7v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M4 4h16v3H4zM10 12h4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </span>
    </li>
  );
}
