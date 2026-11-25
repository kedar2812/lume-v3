"use client";
import { CHAT_LIMITS, bodyProblem } from "@lume/core/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { chatClient, type FileView } from "@/lib/chat/client";
import s from "./chat.module.css";

/** What was being written in each conversation, kept while this tab is open. */
const drafts = new Map<string, { text: string; files: FileView[] }>();

/**
 * Writing a message: Enter sends, Shift+Enter starts a new line; photos and files go up first and then with the
 * message; "typing" is said at most every 3 s while keys are pressed. Editing one's own message uses the same box.
 */
export function Composer({
  label,
  draftKey,
  replying,
  editing,
  onCancel,
  onSend,
  onSave,
  onTyping,
}: {
  label: string;
  draftKey: string;
  /** The message being answered: its sender and words. */
  replying: { who: string; text: string } | null;
  /** One's own message being changed. */
  editing: { id: number; text: string; hasFiles: boolean } | null;
  onCancel: () => void;
  onSend: (text: string, files: FileView[]) => void;
  /** Whether it was saved; if not, the words stay in the box. */
  onSave: (id: number, text: string) => Promise<boolean>;
  onTyping: () => void;
}) {
  const [text, setText] = useState(() => drafts.get(draftKey)?.text ?? "");
  const [files, setFiles] = useState<FileView[]>(() => drafts.get(draftKey)?.files ?? []);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [said, setSaid] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const lastTyped = useRef(0);
  /** Files on this message, those still going up too. */
  const held = useRef(files.length);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Editing: the message's words in the box, ready to change. What was being written waits, and comes back after.
  const editId = editing?.id ?? null;
  const editText = editing?.text ?? "";
  useEffect(() => {
    if (editId === null) return;
    setText(editText);
    setSaid(null);
    box.current?.focus();
    return () => setText(drafts.get(draftKey)?.text ?? "");
    // Its words as editing began: a change that lands meanwhile never types over what's being written.
  }, [editId, draftKey]);
  useEffect(() => {
    if (editId !== null) return;
    if (text || files.length) drafts.set(draftKey, { text, files });
    else drafts.delete(draftKey);
  }, [editId, draftKey, text, files]);
  // As tall as what's in it, to a point, and then it scrolls.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  useEffect(() => {
    if (replying) box.current?.focus();
  }, [replying]);

  const problem = bodyProblem(text, editing ? editing.hasFiles : files.length > 0);
  const ready = !problem && !saving && (!!editing || uploading === 0);
  const go = async () => {
    if (!ready) return;
    setSaid(null);
    if (editing) {
      setSaving(true);
      await onSave(editing.id, text);
      setSaving(false);
      return;
    }
    onSend(text, files);
    held.current = 0;
    setText("");
    setFiles([]);
    // Gone at once: switching away before the next paint must not bring it back.
    drafts.delete(draftKey);
    lastTyped.current = 0;
  };
  const attach = async (list: File[]) => {
    const room = Math.max(0, CHAT_LIMITS.files - held.current);
    setSaid(list.length > room ? `A message can carry at most ${CHAT_LIMITS.files} files.` : null);
    // Counted as they're taken up: a second paste meanwhile sees the first.
    const take = list.slice(0, room);
    held.current += take.length;
    setUploading((n) => n + take.length);
    for (const f of take) {
      const r = await chatClient.upload(f);
      if (!r.ok) held.current--;
      if (!live.current) {
        // Looking at another conversation by now: it waits with what was being written here.
        if (r.ok) {
          const d = drafts.get(draftKey) ?? { text: "", files: [] };
          drafts.set(draftKey, { ...d, files: [...d.files, r.data.file] });
        }
        continue;
      }
      setUploading((n) => n - 1);
      if (r.ok) setFiles((xs) => [...xs, r.data.file]);
      else setSaid(r.message);
    }
  };

  return (
    <div className={s.comp}>
      {(replying || editing) && (
        <div className={s.replying}>
          <span>{editing ? "Editing your message" : `Replying to ${replying!.who}: ${replying!.text}`}</span>
          <button type="button" className={s.tbtn} onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
      <label>
        <span className={s.srx}>{label}</span>
        <textarea
          ref={box}
          className={s.input}
          rows={1}
          placeholder={label}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const now = Date.now();
            if (e.target.value && now - lastTyped.current >= CHAT_LIMITS.typingEveryMs) {
              lastTyped.current = now;
              onTyping();
            }
          }}
          onPaste={(e) => {
            const got = [...e.clipboardData.files];
            if (!got.length || editing) return;
            e.preventDefault();
            void attach(got);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void go();
            } else if (e.key === "Escape" && (editing || replying)) onCancel();
          }}
        />
      </label>
      <div className={s.ctools}>
        {!editing && (
          <label className={`${s.tbtn} ${s.attach}`}>
            <span className={s.srx}>Attach a photo or file</span>
            <span aria-hidden>Attach</span>
            <input
              type="file"
              multiple
              className={s.srx}
              onChange={(e) => {
                void attach([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </label>
        )}
        <span className={s.chips}>
          {!editing &&
            files.map((f) => (
              <span key={f.id} className={s.chip} title={f.name}>
                <span className={s.cn}>{f.name}</span>
                <button
                  type="button"
                  className={s.tbtn}
                  aria-label={`Take off ${f.name}`}
                  onClick={() => {
                    held.current--;
                    setFiles((xs) => xs.filter((x) => x.id !== f.id));
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          {uploading > 0 && <span className={s.chip}>Uploading…</span>}
          {said && (
            <span className={s.chip} role="alert">
              {said}
            </span>
          )}
          {problem && text.length > CHAT_LIMITS.body && <span className={s.chip}>{problem}</span>}
        </span>
        <button
          type="button"
          className={s.send}
          aria-label={editing ? "Save" : "Send"}
          disabled={!ready}
          onClick={() => void go()}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
