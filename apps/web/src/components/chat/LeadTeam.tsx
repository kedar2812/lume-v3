"use client";
import { useEffect, useMemo, useState } from "react";
import { lookOf, type Look } from "@/lib/avatar/look";
import { chatClient, type ConvRow } from "@/lib/chat/client";
import type { Who } from "./Bubble";
import { Conversation } from "./Conversation";
import s from "./chat.module.css";

/**
 * A lead's Team tab (plan 2026-11-24-team-chat-2a, Task 8; canvas board LeadTeam): the team's talk about this lead, in
 * the same bubbles as Chat. Read only by people who can see the lead; the lead never sees it.
 */
export function LeadTeam({
  lead,
  me,
  zone,
  people,
}: {
  lead: { id: string; name: string; stage: string | null };
  me: string;
  zone: string;
  people: { id: string; name: string; avatar?: Look }[];
}) {
  const [conv, setConv] = useState<ConvRow | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [thread, setThread] = useState<number | null>(null);
  const who = useMemo(
    () => new Map<string, Who>(people.map((p) => [p.id, { name: p.name, ...lookOf(p.id, p.avatar) }])),
    [people],
  );
  const { id, name, stage } = lead;
  useEffect(() => {
    let live = true;
    setConv(null);
    setSaid(null);
    setThread(null);
    void chatClient.leadThread(id).then((r) => {
      if (!live) return;
      if (r.ok)
        setConv({
          id: r.data.id,
          kind: "lead",
          name: null,
          topic: null,
          unread: 0,
          muted: false,
          lastAt: null,
        });
      else setSaid(r.message);
    });
    return () => {
      live = false;
    };
  }, [id]);
  const first = lead.name.trim().split(/\s+/)[0] || "";
  return (
    <div className={`${s.cx} ${s.inlead}`} data-open="">
      {said && (
        <p className={s.cnone} role="alert">
          {said}
        </p>
      )}
      {conv && (
        <div className={s.conv}>
          <p className={s.cnone}>
            {first
              ? `Only people who can see ${first}'s lead read this. ${first} never does.`
              : "Only people who can see this lead read this. The lead never does."}
          </p>
          <Conversation
            conv={{ ...conv, lead: { id, name, stage } }}
            me={me}
            people={who}
            zone={zone}
            thread={thread}
            onThread={setThread}
          />
        </div>
      )}
    </div>
  );
}
