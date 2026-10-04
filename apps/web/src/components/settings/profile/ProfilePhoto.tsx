"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AVATAR_COLORS, type AvatarColor } from "@lume/core/shared";
import { Avatar, avatarColor } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { lookOf, type Look } from "@/lib/avatar/look";
import { accountClient } from "@/lib/settings/account";
import type { Session } from "@/server/session";
import { PhotoCropper } from "./PhotoCropper";
import s from "./profile.module.css";

const COLOR_NAMES: Record<AvatarColor, string> = {
  red: "Red",
  amber: "Amber",
  blue: "Blue",
  green: "Green",
  rose: "Rose",
  teal: "Teal",
};
const MAX_FILE = 20 * 1024 * 1024;

/**
 * Your look (7C, canvas Profile): your initials on a colour you pick — or LUME's, from your name — or a photo you
 * line up. Everyone you work with sees it beside your name.
 */
export function ProfilePhoto({ session }: { session: Session }) {
  const router = useRouter();
  const user = session.user;
  const [look, setLook] = useState<Look>(user.avatar ?? { color: null, version: 0, photo: false });
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; problem?: boolean } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => () => void (picked && URL.revokeObjectURL(picked)), [picked]);

  const done = (next: Look, text: string) => {
    setLook(next);
    setNote({ text });
    router.refresh(); // the sidebar and the lists show the new look
  };
  const choose = (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/"))
      return setNote({ text: "Choose a photo: a JPEG, PNG or WebP image.", problem: true });
    if (f.size > MAX_FILE)
      return setNote({ text: "That photo is over 20 MB. Choose a smaller one.", problem: true });
    setNote(null);
    setPicked(URL.createObjectURL(f));
  };
  const color = async (c: AvatarColor | null) => {
    const r = await accountClient.setAvatar({ color: c });
    if (!r.ok) return setNote({ text: r.message || "LUME couldn’t save that colour.", problem: true });
    done(r.data.avatar, "Saved");
  };
  const remove = async () => {
    const r = await accountClient.removePhoto();
    if (!r.ok) return setNote({ text: r.message || "LUME couldn’t remove your photo.", problem: true });
    done(r.data.avatar, "Photo removed. Your initials show instead.");
  };

  const shown = lookOf(user.id, look);
  return (
    <div className={s.look}>
      <button
        type="button"
        className={s.big}
        onClick={() => file.current?.click()}
        aria-label={look.photo ? "Change your photo" : "Choose a photo"}
      >
        <Avatar name={user.name} size={72} {...shown} />
        <span className={s.camera} aria-hidden>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
            <circle cx="12" cy="13" r="3.5" />
          </svg>
        </span>
      </button>
      <div className={s.lookSide}>
        <div className={s.lookButtons}>
          <Button onClick={() => file.current?.click()}>
            {look.photo ? "Change photo…" : "Choose a photo…"}
          </Button>
          {look.photo && (
            <Button variant="ghost" onClick={() => void remove()}>
              Remove photo
            </Button>
          )}
        </div>
        <div className={s.swatches} role="radiogroup" aria-label="Colour behind your initials">
          <button
            type="button"
            role="radio"
            aria-checked={look.color === null}
            aria-label="LUME’s pick"
            title="LUME’s pick"
            className={s.swatch}
            style={{ background: avatarColor(user.name) }}
            onClick={() => void color(null)}
          >
            <span>A</span>
          </button>
          {(Object.keys(AVATAR_COLORS) as AvatarColor[]).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={look.color === c}
              aria-label={COLOR_NAMES[c]}
              title={COLOR_NAMES[c]}
              className={s.swatch}
              style={{ background: AVATAR_COLORS[c] }}
              onClick={() => void color(c)}
            />
          ))}
        </div>
        {note && (
          <p role={note.problem ? "alert" : "status"} className={note.problem ? s.problem : s.ok}>
            {note.text}
          </p>
        )}
      </div>
      <input
        ref={file}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {picked && (
        <PhotoCropper
          src={picked}
          onCancel={() => setPicked(null)}
          onSave={async (image) => {
            const r = await accountClient.setAvatar({ image });
            if (!r.ok) return r.message || "LUME couldn’t save your photo.";
            setPicked(null);
            done(r.data.avatar, "Your photo is saved.");
            return null;
          }}
        />
      )}
    </div>
  );
}
