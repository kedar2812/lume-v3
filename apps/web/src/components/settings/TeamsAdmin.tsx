"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { ApiResult } from "@/lib/api";
import type { Person } from "@/lib/leads/types";
import { teamsClient, type Team, type TeamMember } from "@/lib/settings/teams";
import { accessGone } from "@/lib/settings/access";
import { AccessChanged } from "./AccessChanged";
import s from "./settings.module.css";

type Note = { text: string; problem?: boolean } | null;

/**
 * Teams: who works together and who leads them. Tick people in, pick the lead from the members; each
 * change saves at once, and a refusal puts the team back as it was. Deleting a team asks first.
 */
export function TeamsAdmin({ teams: initial, people }: { teams: Team[]; people: Person[] }) {
  const [teams, setTeams] = useState(initial);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<Note>(null);
  const [forbidden, setForbidden] = useState(false);

  if (forbidden) return <AccessChanged />;

  const landed = <T,>(r: ApiResult<T>): r is Extract<ApiResult<T>, { ok: true }> => {
    if (r.ok) return true;
    if (accessGone(r)) setForbidden(true);
    else setNote({ text: r.message || "That couldn’t be saved.", problem: true });
    return false;
  };

  const put = (team: Team, members: TeamMember[]) =>
    setTeams((all) => all.map((t) => (t.id === team.id ? { ...t, members } : t)));
  const saveMembers = async (team: Team, members: TeamMember[]) => {
    put(team, members);
    setNote(null);
    if (!landed(await teamsClient.setMembers(team.id, members))) put(team, team.members);
  };

  return (
    <div className={s.stack}>
      <form
        method="post"
        className={s.addRow + " " + s.addTeam}
        onSubmit={async (e) => {
          e.preventDefault();
          const name = draft.trim();
          if (!name) return;
          const r = await teamsClient.create(name);
          if (!landed(r)) return;
          setTeams((all) => [...all, r.data.team].sort((a, b) => a.name.localeCompare(b.name)));
          setDraft("");
          setNote({ text: `${name} created. Tick who’s in it.` });
        }}
      >
        <label htmlFor="new-team" className={s.srOnly}>
          New team
        </label>
        <input
          id="new-team"
          className={s.addInput}
          placeholder="Add a team, like Dubai or Inbound…"
          maxLength={60}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!draft.trim()}>
          Add
        </Button>
      </form>

      {note &&
        (note.problem ? (
          <p role="alert" className={s.problem}>
            {note.text}
          </p>
        ) : (
          <p role="status" className={s.saved}>
            {note.text}
          </p>
        ))}

      {teams.length === 0 && (
        <p className={s.muted}>No teams yet. Teams let a lead see and help with their team’s leads.</p>
      )}

      {teams.map((team) => (
        <TeamCard
          key={team.id}
          team={team}
          people={people.filter((p) => p.active || team.members.some((m) => m.userId === p.id))}
          onMembers={(members) => void saveMembers(team, members)}
          onRename={async (name) => {
            if (!landed(await teamsClient.rename(team.id, name))) return;
            setTeams((all) => all.map((t) => (t.id === team.id ? { ...t, name } : t)));
            setNote({ text: `Renamed to ${name}.` });
          }}
          onDelete={async () => {
            if (!landed(await teamsClient.remove(team.id))) return;
            setTeams((all) => all.filter((t) => t.id !== team.id));
            setNote({ text: `${team.name} deleted. Its people keep their leads.` });
          }}
        />
      ))}
    </div>
  );
}

function TeamCard({
  team,
  people,
  onMembers,
  onRename,
  onDelete,
}: {
  team: Team;
  people: Person[];
  onMembers: (members: TeamMember[]) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const member = (id: string) => team.members.find((m) => m.userId === id);
  const count = team.members.length;

  return (
    <section className={s.panel} aria-label={team.name}>
      <div className={s.teamHead} data-asking={asking || undefined}>
        {asking ? (
          <div className={s.ask} role="group" aria-label={`Delete ${team.name}?`}>
            <p>
              <b>Delete {team.name}?</b> Its people stay in LUME and keep their leads.
            </p>
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={onDelete}>
              Delete team
            </Button>
          </div>
        ) : (
          <>
            {renaming ? (
              <input
                className={s.rename}
                aria-label="Team name"
                defaultValue={team.name}
                autoFocus
                maxLength={60}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setRenaming(false);
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const name = e.currentTarget.value.trim();
                  setRenaming(false);
                  if (name && name !== team.name) onRename(name);
                }}
                onBlur={() => setRenaming(false)}
              />
            ) : (
              <h2 className={s.panelTitle}>{team.name}</h2>
            )}
            <span className={s.teamCount}>
              {count === 0 ? "No one yet" : `${count} ${count === 1 ? "person" : "people"}`}
            </span>
            {!renaming && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Rename ${team.name}`}
                onClick={() => setRenaming(true)}
              >
                Rename
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete ${team.name}`}
              onClick={() => setAsking(true)}
            >
              Delete
            </Button>
          </>
        )}
      </div>
      <table className={s.teamTable}>
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">In the team</th>
            <th scope="col">Leads it</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => {
            const m = member(p.id);
            return (
              <tr key={p.id} data-in={m ? true : undefined}>
                <th scope="row">
                  {p.name}
                  {!p.active && <span className={s.you}> · disabled</span>}
                </th>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${p.name} in ${team.name}`}
                    checked={!!m}
                    onChange={(e) =>
                      onMembers(
                        e.target.checked
                          ? [...team.members, { userId: p.id, isLead: false }]
                          : team.members.filter((x) => x.userId !== p.id),
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    type="radio"
                    name={`lead-${team.id}`}
                    aria-label={`${p.name} leads ${team.name}`}
                    disabled={!m}
                    checked={!!m?.isLead}
                    onChange={() => onMembers(team.members.map((x) => ({ ...x, isLead: x.userId === p.id })))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
