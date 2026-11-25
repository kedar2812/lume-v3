"use client";
import {
  CHAT_LIMITS,
  bodyProblem,
  decodeMentions,
  encodeMentions,
  keepPicked,
  type Picked,
} from "@lume/core/shared";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { chatClient, type FileView } from "@/lib/chat/client";
import { MentionMenu, askedFor, type Option } from "./MentionMenu";
import type { NameOf } from "./Words";
import s from "./chat.module.css";

/** What was being written in each conversation, kept while this tab is open. */
const drafts = new Map<string, { text: string; files: FileView[]; picked: Picked[] }>();

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
  also,
  nameOf,
  optionsFor,
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
  /** In a thread: the same words in the conversation too, when ticked. */
  also?: { label: string; on: boolean; set: (on: boolean) => void };
  nameOf: NameOf;
  /** Whoever the words after an @ may mean. */
  optionsFor: (words: string) => Option[];
}) {
  const [text, setText] = useState(() => drafts.get(draftKey)?.text ?? "");
  const [files, setFiles] = useState<FileView[]>(() => drafts.get(draftKey)?.files ?? []);
  /** Whoever was chosen from the menu, in the order chosen. */
  const [picked, setPicked] = useState<Picked[]>(() => drafts.get(draftKey)?.picked ?? []);
  const menuId = useId();
  /** The name being written, and the line of the menu the arrows are on; shut by Escape until the next @. */
  const [asked, setAsked] = useState<{ at: number; words: string } | null>(null);
  const [line, setLine] = useState(0);
  const shut = useRef<number | null>(null);
  const lookRef = useRef<(el: HTMLTextAreaElement) => void>(() => undefined);
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
    const words = decodeMentions(editText, nameOf);
    setText(words.text);
    setPicked(words.picked);
    setAsked(null);
    setSaid(null);
    box.current?.focus();
    return () => {
      const d = drafts.get(draftKey);
      setText(d?.text ?? "");
      setPicked(d?.picked ?? []);
      setAsked(null);
    };
    // Its words as editing began: a change that lands meanwhile never types over what's being written.
  }, [editId, draftKey]);
  useEffect(() => {
    if (editId !== null) return;
    if (text || files.length) drafts.set(draftKey, { text, files, picked });
    else drafts.delete(draftKey);
  }, [editId, draftKey, text, files, picked]);
  // As tall as what's in it, to a point, and then it scrolls.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  /** Where the caret goes once words put in by LUME (a name, an @) are in the box. */
  const toCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const at = toCaret.current;
    if (!el || at === null) return;
    toCaret.current = null;
    el.focus();
    el.setSelectionRange(at, at);
    lookRef.current(el);
  }, [text]);
  useEffect(() => {
    if (replying) box.current?.focus();
  }, [replying]);

  /** The words as they go: names are whom they name. */
  const body = encodeMentions(text, picked);
  const problem = bodyProblem(body, editing ? editing.hasFiles : files.length > 0);
  const ready = !problem && !saving && (!!editing || uploading === 0);
  const go = async () => {
    if (!ready) return;
    setSaid(null);
    if (editing) {
      setSaving(true);
      await onSave(editing.id, body);
      setSaving(false);
      return;
    }
    onSend(body, files);
    held.current = 0;
    setText("");
    setPicked([]);
    setAsked(null);
    setFiles([]);
    // Gone at once: switching away before the next paint must not bring it back.
    drafts.delete(draftKey);
    lastTyped.current = 0;
  };
  const options = asked ? optionsFor(asked.words) : [];
  const menu = options.length > 0;
  const on = Math.min(line, options.length - 1);
  /** What is being written at the caret may be a name. */
  const look = (el: HTMLTextAreaElement) => {
    const a = el.selectionStart === el.selectionEnd ? askedFor(el.value, el.selectionStart) : null;
    if (a?.at !== shut.current) shut.current = null;
    setAsked(a && shut.current === null ? a : null);
    if (a?.words !== asked?.words) setLine(0);
  };
  lookRef.current = look;
  const pick = (o: Option) => {
    const el = box.current;
    if (!el || !asked) return;
    const end = asked.at + 1 + asked.words.length;
    const next = `${text.slice(0, asked.at)}${o.label} ${text.slice(end).replace(/^ /, "")}`;
    const caret = asked.at + o.label.length + 1;
    // Chosen: the words after it are words, however another name goes on.
    shut.current = asked.at;
    setText(next);
    // The very words that were there: nothing is drawn again, so the caret is put there now.
    if (next === text) el.setSelectionRange(caret, caret);
    else toCaret.current = caret;
    // In the order they stand in the words: two of one name are told apart by it.
    const before = text.slice(0, asked.at).split(o.label).length - 1;
    setPicked((ps) => {
      const same = ps.filter((p) => p.label === o.label);
      const rest = ps.filter((p) => p.label !== o.label);
      const mine = { label: o.label, token: o.token };
      return [...rest, ...same.slice(0, before), mine, ...same.slice(before)];
    });
    setAsked(null);
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
          const d = drafts.get(draftKey) ?? { text: "", files: [], picked: [] };
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
      {menu && <MentionMenu id={menuId} options={options} at={on} onPick={pick} />}
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
          aria-autocomplete="list"
          aria-controls={menu ? menuId : undefined}
          aria-activedescendant={menu ? `${menuId}-${on}` : undefined}
          onSelect={(e) => look(e.currentTarget)}
          onBlur={() => setAsked(null)}
          onChange={(e) => {
            setText(e.target.value);
            const caret = e.target.selectionStart;
            setPicked((ps) => keepPicked(text, e.target.value, caret, ps));
            look(e.target);
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
            if (menu && !e.nativeEvent.isComposing) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setLine((on + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
                return;
              }
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                e.preventDefault();
                pick(options[on]!);
                return;
              }
              if (e.key === "Escape") {
                // The menu alone: what it's in stays as it is.
                e.stopPropagation();
                shut.current = asked!.at;
                setAsked(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void go();
            } else if (e.key === "Escape" && !e.nativeEvent.isComposing && (editing || replying)) {
              // Gives up this alone: the thread it may be in stays open.
              e.stopPropagation();
              onCancel();
            }
          }}
        />
      </label>
      <div className={s.ctools}>
        <button
          type="button"
          className={s.tbtn}
          aria-label="Mention someone"
          title="Mention someone"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const el = box.current;
            if (!el) return;
            const at = el.selectionStart;
            const gap = at > 0 && !/\s/.test(text[at - 1]!) ? " " : "";
            setText(`${text.slice(0, at)}${gap}@${text.slice(at)}`);
            const caret = at + gap.length + 1;
            toCaret.current = caret;
          }}
        >
          @
        </button>
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
          {problem && body.length > CHAT_LIMITS.body && <span className={s.chip}>{problem}</span>}
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
      {also && !editing && (
        <label className={s.also}>
          <input type="checkbox" checked={also.on} onChange={(e) => also.set(e.target.checked)} />
          <span>{also.label}</span>
        </label>
      )}
    </div>
  );
}
