"use client";
import { CHAT_LIMITS, channelNameProblem } from "@lume/core/shared";
import { useEffect, useMemo, useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { fold } from "@/components/ui/SearchList";
import { Switch } from "@/components/ui/Switch";
import { lookOf } from "@/lib/avatar/look";
import { chatClient, type ChannelAdmin, type GroupRef, type ManagedChannel } from "@/lib/chat/client";
import type { ChatPerson } from "./ChatScreen";
import s from "./chat.module.css";

/** People to tick, found by name; however many there are, the list stays inside the sheet. */
function PeoplePicker({
  people,
  chosen,
  onToggle,
  label,
}: {
  people: ChatPerson[];
  chosen: ReadonlySet<string>;
  onToggle: (id: string) => void;
  label: string;
}) {
  const [q, setQ] = useState("");
  const found = useMemo(() => people.filter((p) => fold(p.name).includes(fold(q.trim()))), [people, q]);
  return (
    <div className={s.picker} role="group" aria-label={label}>
      <input
        type="search"
        className={s.psearch}
        aria-label="Search people"
        placeholder="Search by name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className={s.plist}>
        {found.length === 0 && <li className={s.cnone}>No one here by that name.</li>}
        {found.map((p) => (
          <li key={p.id}>
            <label className={s.prow}>
              <input type="checkbox" checked={chosen.has(p.id)} onChange={() => onToggle(p.id)} />
              <Avatar name={p.name} size={26} {...lookOf(p.id, p.avatar ?? undefined)} />
              <span className={s.cn}>{p.name}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
const toggled = (cur: ReadonlySet<string>, id: string) => {
  const next = new Set(cur);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

/** Start a direct message: one person, or a few. The same people always open the same one. */
export function NewDirect({
  people,
  me,
  onClose,
  onOpen,
}: {
  people: ChatPerson[];
  me: string;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const others = useMemo(() => people.filter((p) => p.id !== me && p.active !== false), [people, me]);
  const tooMany = chosen.size + 1 > CHAT_LIMITS.directPeople;
  const go = async () => {
    setBusy(true);
    setSaid(null);
    const r = await chatClient.direct([...chosen]);
    setBusy(false);
    if (r.ok) onOpen(r.data.id);
    else setSaid(r.message);
  };
  return (
    <Sheet
      label="New direct message"
      onClose={onClose}
      footer={
        <div className={s.sfoot}>
          <span role={tooMany || said ? "alert" : undefined}>
            {tooMany
              ? `A direct message can have at most ${CHAT_LIMITS.directPeople} people.`
              : (said ?? (chosen.size ? `${chosen.size} chosen` : "Choose who to message"))}
          </span>
          <Button
            variant="primary"
            loading={busy}
            disabled={!chosen.size || tooMany}
            onClick={() => void go()}
          >
            Start
          </Button>
        </div>
      }
    >
      <header className={s.shead}>
        <h2>New direct message</h2>
        <p>Only the people in it can read it.</p>
      </header>
      <PeoplePicker
        people={others}
        chosen={chosen}
        onToggle={(id) => setChosen((c) => toggled(c, id))}
        label="Who to message"
      />
    </Sheet>
  );
}

const keyOf = (g: GroupRef) => (g.kind === "everyone" ? "everyone" : `${g.kind}:${g.id}`);
const refOf = (key: string): GroupRef => {
  if (key === "everyone") return { kind: "everyone" };
  const [kind, id] = key.split(":") as ["team" | "role", string];
  return { kind, id };
};

/** Make, rename, fill, archive and bring back channels: for whoever manages them, in a channel or not. */
export function Channels({
  people,
  me,
  onClose,
  onChanged,
}: {
  people: ChatPerson[];
  me: string;
  onClose: () => void;
  onChanged: (open?: string) => void;
}) {
  const [data, setData] = useState<ChannelAdmin | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [editing, setEditing] = useState<ManagedChannel | "new" | null>(null);
  const load = async () => {
    const r = await chatClient.channels();
    if (r.ok) setData(r.data);
    else setSaid(r.message);
  };
  useEffect(() => void load(), []);
  if (editing && data)
    return (
      <ChannelForm
        key={editing === "new" ? "new" : editing.id}
        channel={editing === "new" ? null : editing}
        admin={data}
        people={people}
        me={me}
        onClose={onClose}
        onBack={() => setEditing(null)}
        onDone={(id) => {
          const made = editing === "new";
          setEditing(null);
          void load();
          onChanged(made ? id : undefined);
        }}
      />
    );
  const rows = [...(data?.channels ?? [])].sort(
    (a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name),
  );
  return (
    <Sheet
      label="Channels"
      onClose={onClose}
      footer={
        <div className={s.sfoot}>
          <span role={said ? "alert" : undefined}>{said}</span>
          <Button variant="primary" disabled={!data} onClick={() => setEditing("new")}>
            New channel
          </Button>
        </div>
      }
    >
      <header className={s.shead}>
        <h2>Channels</h2>
        <p>Choose who is in each. People see only the channels they&apos;re in.</p>
      </header>
      {!data && !said && (
        <div role="status" aria-busy aria-label="Getting the channels">
          <Skeleton height={44} radius={10} />
        </div>
      )}
      <ul className={s.plist}>
        {rows.map((c) => (
          <li key={c.id}>
            <button type="button" className={s.prow} onClick={() => setEditing(c)}>
              <span className={s.hash} aria-hidden>
                #
              </span>
              <span className={s.cn}>{c.name}</span>
              <span className={s.pnote}>
                {c.archived ? "Archived" : `${c.members.toLocaleString("en-IN")} in it`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function ChannelForm({
  channel,
  admin,
  people,
  me,
  onClose,
  onBack,
  onDone,
}: {
  channel: ManagedChannel | null;
  admin: ChannelAdmin;
  people: ChatPerson[];
  me: string;
  onClose: () => void;
  onBack: () => void;
  onDone: (id: string) => void;
}) {
  const [name, setName] = useState(channel?.name ?? "");
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(channel?.people ?? [me]));
  const [groups, setGroups] = useState<ReadonlySet<string>>(new Set((channel?.groups ?? []).map(keyOf)));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // Someone who left is kept as they are: shown only while they're in it.
  const pickable = useMemo(
    () => people.filter((p) => p.active !== false || (channel?.people ?? []).includes(p.id)),
    [people, channel],
  );
  const problem = name.trim() ? channelNameProblem(name.trim()) : null;
  const run = async (f: () => Promise<{ ok: true } | { ok: false; message: string }>, id?: string) => {
    setBusy(true);
    setSaid(null);
    const r = await f();
    setBusy(false);
    if (r.ok) onDone(id ?? made.current);
    else setSaid(r.message);
  };
  const [made] = useState({ current: channel?.id ?? "" });
  const save = () =>
    run(async () => {
      const b = { people: [...chosen], groups: [...groups].map(refOf) };
      if (!channel) {
        const r = await chatClient.makeChannel({
          name: name.trim(),
          ...(topic.trim() ? { topic: topic.trim() } : {}),
          ...b,
        });
        if (r.ok) made.current = r.data.id;
        return r;
      }
      if (name.trim() !== channel.name || topic.trim() !== (channel.topic ?? "")) {
        const r = await chatClient.changeChannel(channel.id, { name: name.trim(), topic: topic.trim() });
        if (!r.ok) return r;
      }
      return chatClient.setMembers(channel.id, b);
    });
  const archive = (archived: boolean) =>
    run(
      () =>
        chatClient.changeChannel(channel!.id, {
          archived,
          // Back under the name in the box, so a name taken meanwhile can be changed first.
          ...(archived ? {} : { name: name.trim() }),
        }),
      channel!.id,
    );
  const group = (key: string, label: string) => (
    <Switch
      key={key}
      checked={groups.has(key)}
      label={label}
      onChange={() => setGroups((g) => toggled(g, key))}
    />
  );
  const title = channel ? `#${channel.name}` : "New channel";
  return (
    <Sheet
      label={title}
      onClose={onClose}
      headerEnd={
        <Button size="sm" variant="ghost" onClick={onBack}>
          All channels
        </Button>
      }
      footer={
        <div className={s.sfoot}>
          <span role={said ? "alert" : undefined}>{said}</span>
          {channel && (
            <Button loading={busy} onClick={() => void archive(!channel.archived)}>
              {channel.archived ? "Bring back" : "Archive"}
            </Button>
          )}
          {!channel?.archived && (
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim() || !!problem}
              onClick={() => void save()}
            >
              {channel ? "Save" : "Make channel"}
            </Button>
          )}
        </div>
      }
    >
      <header className={s.shead}>
        <h2>{title}</h2>
        {channel?.archived && <p>Archived: nobody can write in it, and nothing said in it is lost.</p>}
      </header>
      <div className={s.sform}>
        <Field label="Name" error={problem}>
          {(c) => (
            <input
              {...c}
              value={name}
              maxLength={80}
              autoComplete="off"
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
            />
          )}
        </Field>
        <Field label="What it's for (optional)">
          {(c) => (
            <input
              {...c}
              value={topic}
              maxLength={CHAT_LIMITS.topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          )}
        </Field>
        {!channel?.archived && (
          <>
            <div className={s.sgroups} role="group" aria-label="Everyone in">
              <b>Always in it</b>
              {group("everyone", "Everyone")}
              {admin.teams.map((t) => group(`team:${t.id}`, t.name))}
              {admin.roles.map((t) => group(`role:${t.id}`, t.name))}
            </div>
            <b>People</b>
            <PeoplePicker
              people={pickable}
              chosen={chosen}
              onToggle={(id) => setChosen((c) => toggled(c, id))}
              label="People in the channel"
            />
          </>
        )}
      </div>
    </Sheet>
  );
}
