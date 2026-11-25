"use client";
import { CHANNEL_TOKEN, personToken, teamToken, type Picked } from "@lume/core/shared";
import { Avatar } from "@/components/ui/Avatar";
import type { Mentionable } from "@/lib/chat/client";
import type { Who } from "./Bubble";
import s from "./chat.module.css";

/** One line of the menu: a person, a team, or everyone. */
export type Option = Picked & { key: string; name: string; note: string; who?: Who };

/** The words after the @ being written, up to the caret; null when no name is being written. */
export function askedFor(text: string, caret: number): { at: number; words: string } | null {
  const m = /(?:^|[\s(])@([^\n@]{0,40})$/u.exec(text.slice(0, caret));
  // A space straight after the @ is an @, not a name.
  if (!m || /^\s/.test(m[1]!)) return null;
  return { at: caret - m[1]!.length - 1, words: m[1]! };
}

const fold = (x: string) => x.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
/** Whoever the words may mean: each of the name's words, or the whole, starts with them. Eight at most. */
export function optionsFor(
  words: string,
  can: Mentionable,
  people: ReadonlyMap<string, Who & { active?: boolean }>,
  me: string,
): Option[] {
  const q = fold(words);
  const hit = (name: string) => {
    const n = fold(name);
    return n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q));
  };
  const ids = can.members ?? [...people.keys()];
  const named = ids
    .filter((id) => id !== me && people.has(id) && people.get(id)!.active !== false)
    .map((id) => ({ id, who: people.get(id)! }))
    .filter((p) => hit(p.who.name))
    .sort((a, b) => a.who.name.localeCompare(b.who.name))
    .map(({ id, who }) => ({
      key: id,
      name: who.name,
      note: "",
      who,
      label: `@${who.name}`,
      token: personToken(id),
    }));
  const teams = can.teams
    .filter((t) => hit(t.name))
    .map((t) => ({
      key: t.id,
      name: t.name,
      note: "Team",
      label: `@${t.name}`,
      token: teamToken(t.id),
    }));
  const everyone =
    can.everyone && "channel".startsWith(q)
      ? [{ key: "channel", name: "channel", note: "Everyone here", label: "@channel", token: CHANNEL_TOKEN }]
      : [];
  return [...named, ...teams, ...everyone].slice(0, 8);
}

/** The names that fit what's being written, over the box (canvas board Main): the arrows move, Enter or Tab takes one. */
export function MentionMenu({
  id,
  options,
  at,
  onPick,
}: {
  id: string;
  options: Option[];
  at: number;
  onPick: (o: Option) => void;
}) {
  return (
    <div className={s.mmenu} role="listbox" id={id} aria-label="Mention someone">
      {options.map((o, i) => (
        <button
          key={o.key}
          type="button"
          role="option"
          id={`${id}-${i}`}
          tabIndex={-1}
          className={s.mopt}
          aria-selected={i === at}
          // The box keeps the keyboard.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(o)}
        >
          {o.who ? <Avatar size={22} {...o.who} /> : <span className={s.hash}>@</span>}
          <span className={s.cn}>{o.name}</span>
          {o.note && <span className={s.pnote}>{o.note}</span>}
        </button>
      ))}
    </div>
  );
}
