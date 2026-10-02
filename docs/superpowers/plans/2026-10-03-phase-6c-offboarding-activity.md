# Phase 6C — Offboarding and Security activity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native). Steps use checkbox (`- [ ]`) syntax for tracking. Tests are described in prose and written in full, first.

**Goal:**
- **Offboarding.** Disabling someone becomes a guided flow, in order:
  1. sign them out everywhere;
  2. hand on their leads (to one person, shared across a team by who has the fewest open leads, or left unassigned), with a preview;
  3. disconnect their Google Calendar, their meetings going with their leads;
  4. their last 30 days.

  It's recorded as one `user.offboarded` audit entry listing each step's outcome. Reachable from People, and from an alert's drawer ("Offboard {Name}").
- **Security activity.** Settings → Security → Overview gains §13's Security module, for `audit.view`: today's tiles, contacts opened per person (14 days, small multiples), and who is signed in now (with Sign out). Every number opens the Audit log filtered to it.

Built to the owner's canvas https://claude.ai/artifact/M8FauNrEgtF9T62PkF69ka: boards [Offboard] and [Main] (the tiles, chart and sessions).

**Architecture:**
- **Two API routes for offboarding:** a preview (`GET /users/:id/offboarding`) and the act (`POST /users/:id/offboard`), in one request transaction.
- **Leads:** they move through a new `reassign_leads_spread(from, team, by)` SQL function, beside the existing `reassign_all_leads`. It writes `lead_assignment_history` the same way, with reason `owner_offboarded`.
- **The calendar:** handled with the calendar sweep's row-level-security flag (`lume.calendar_sweep`). Lead-linked meetings move to the lead's new owner (dropping any duplicate the new owner already has); meetings with no lead go; then the connection (the grant) is deleted.
- **Security activity:** one read route, `GET /security/activity` (`audit.view`). It reads counts from the audit log, `reveal_counters`, `lead_exports`, `security_alerts` and `sessions`. Figures only: no contact data.

**Spec:** `docs/superpowers/specs/2026-10-01-phase-6-anti-exfiltration-design.md` §4.

## Rulings taken while planning (cost if wrong)

- **C1. "Share across a team"** offers the teams the person belongs to (else any team). Each lead goes, oldest first, to the active member, other than the person, with the fewest open leads at that moment (ties by name). Cost if wrong: a busy member gets slightly fewer leads.
- **C2. Meetings go with their leads.** A lead-linked meeting moves to the lead's new owner; an unassigned lead's meetings go unowned-by-connection, kept on the lead; meetings with no lead are deleted with the connection. Cost if wrong: an unlinked meeting someone wanted is gone (they were the person's own, unattached).
- **C3. Offboarding needs `users.manage`**, as Disable does. Their last 30 days show to that admin. The figures are counts, never contacts. Cost if wrong: none meaningful.
- **C4. Security activity sits in the Overview,** under the alerts (canvas [Main]), for `audit.view`. A security admin without `audit.view` sees alerts only. Cost if wrong: none.
- **C5. "Contacts opened" counts different leads per person per day** (as the reveals rule now does). The 14-day chart reads `audit_log`, not `reveal_counters` (which counts every reveal). Cost if wrong: the chart reads lower than raw reveal clicks.

## Global Constraints

- **Words.** Copy speaks as LUME. Red marks Offboard, the act that can't be undone (the person can be enabled again, but sessions, hand-over and calendar aren't put back). The steps tick in order with the approved check pop. No sound.
- **Never more than the viewer may see:** activity counts only, and names only of people.
- **Keyboard and motion.** Every control works by keyboard. Reduce Motion gets cross-fades. The sheet traps focus, Escape cancels before it starts, and the person can't close it mid-run.
- **Process.** Tests run on the dev box; push per task; read CI; keep the ledger current; one fresh reviewer at the end.

## Review Focus

1. **Atomic offboarding.** A failure in any step rolls back everything: no half-offboarded person. (Task 1 test: force the calendar step to fail; status, sessions and leads are unchanged.)
2. **Spread fairness and scope.** Spreading over a team never gives leads to the person being offboarded, a disabled member or a suspended member; the counts sum to the leads moved. (Task 1 tests.)
3. **Meetings and duplicates.** The new owner already holding the same Google event keeps one meeting, not two; unlinked meetings are gone; the connection's grant is gone. (Task 1 test.)
4. **The owner and yourself.** Offboarding the owner, or yourself, is refused (as Disable is). (Task 1 test.)
5. **Activity in the right time zone.** Day buckets on the business's clock; a reveal at 23:30 in Dubai counts on that Dubai day. (Task 3 test.)

---

### Task 1: Offboarding API

**Files:**
- migration `0044_offboarding.sql` (`reassign_leads_spread`, and the reason `owner_offboarded` if a CHECK lists reasons);
- `apps/api/src/modules/users/offboard.ts` (+test), routes in `users/routes.ts`;
- probes.

- **`GET /api/v1/users/:id/offboarding`** (`users.manage`) gives:
  - `person` (name, status);
  - `sessions` (live count);
  - `leads` (`total`, `open`);
  - `teams` (`[{ id, name, members: [{ id, name, openLeads }] }]`, the person's teams first, active members only, excluding the person);
  - `people` (active, for "one person");
  - `calendar` (`null` or `{ email, upcoming }`);
  - `last30` (`reveals`, `leadsOpened`, `exports`, `alerts`, `busiest: { day, count } | null`, `usualPerDay`).
- **`POST /api/v1/users/:id/offboard`** (`users.manage`) takes `{ leads: { to: "person", userId } | { to: "team", teamId } | { to: "none" } }`. In one transaction, it:
  1. sets status `disabled` and ends every session (reason `user_offboarded`);
  2. hands on the leads;
  3. disconnects the calendar (C2);
  4. resolves open security alerts as `offboarded`;
  5. audits `user.offboarded` with `{ sessions, leads: { to, moved, shares? }, calendar: { meetingsMoved, meetingsRemoved } | null }`.

  It gives the same outcome object for the screen. Refused with `OWNER_PROTECTED`, `SELF`, `NOT_ACTIVE` (already disabled), `UNKNOWN_USER` or `UNKNOWN_TEAM`.
- [ ] **Tests first:**
  - the preview's numbers;
  - offboard to a person;
  - spread over a team (Review Focus 2);
  - left unassigned;
  - the calendar (Review Focus 3);
  - Review Focus 1 (an injected failure through a test hook) and 4;
  - the audit entry;
  - the alerts resolved;
  - the probes.
- [ ] **RED → GREEN →** full suite, commit, push, CI, ledger.

### Task 2: The Offboard sheet [Offboard]

**Files:**
- **The sheet:** new `components/settings/OffboardSheet.tsx` (+test) and `offboard.module.css`; `lib/settings/people.ts` (the client);
- **Entry points:** `PeopleAdmin.tsx` (Disable becomes **Offboard**, in red; `?offboard=<id>` opens it); the 6A alert drawer gains "Offboard {Name}" (a link to `/settings/people?offboard=<id>`);
- **e2e:** People and Security specs, with review copies.

**Design ([Offboard]):**
- **Header:** "Offboard {Name}", with "{First} won't be able to sign in. You can bring them back later."
- **Four numbered steps:**
  1. "Sign {First} out everywhere" (`n` sessions, or "Already signed out");
  2. "Hand on {First}'s {n} leads": three option cards. "Share them across the {Team} team" ("Whoever has the fewest open leads gets the next one") shows a live preview of each member's share and a team select when there are several. "Give them all to one person" has a person select. "Leave them unassigned" ("An admin hands them out later");
  3. "Disconnect {First}'s Google Calendar" ("{email} · LUME stops reading it at once"), shown only when connected;
  4. "{First}'s last 30 days": four figures (contacts opened, leads opened, exports, alerts), the busiest day against their usual, and "Open {First}'s audit log".
- **Footer:** **Cancel** and **Offboard {First}** (red).
- **On Offboard:** the steps tick in order, 1→4, each turning its number into a check with the pop, and its result line ("Done · 214 leads shared: Sam 72, Priya 71, Hana 71"). Then "{Name} is offboarded. LUME recorded every step." and **Done**. The sheet can't be closed mid-run.
- [ ] **Tests first:**
  - the preview's words;
  - each hand-on choice's request;
  - the ticking results after the response;
  - a refusal's words;
  - People's Offboard button and `?offboard=`;
  - the drawer's link;
  - the e2e: offboard a person spread over a team, with review copies in both themes and axe.
- [ ] **RED → GREEN →** web suite and e2e, review copies read, commit, push, CI, ledger.

### Task 3: Security activity (API + the Overview) [Main]

**Files:**
- new `apps/api/src/modules/security/activity.ts` (+test), with a route `GET /api/v1/security/activity` (`audit.view`); probes;
- `components/settings/security/{ActivityTiles,RevealChart,LiveSessions}.tsx` (+tests); `OverviewTab.tsx`; the page passes `canAudit`.

- **The route gives:**
  - `today`: contacts opened (different leads, all people) and by how many people; leads opened and how that compares with the 14-day median ("about usual", "N× usual"); exports this week (and by whom, when one person); failed sign-ins today (and the name when one person);
  - `reveals`: 14 days × people (the top 6 by total), each `{ id, name, role, total, days: number[14] }`, days on the business's clock;
  - `sessions`: live sessions (name, device, since, is you), newest first.
- **The Overview** (canvas [Main]), under the alerts:
  - four tiles, each a link to the Audit log filtered to it (action and day);
  - "Contacts opened, per person": small multiples, one row per person (initials, name, role, total, 14 bars with today emphasised: blue, or amber when over the reveals limit);
  - "Signed in now: {n} sessions": rows with a Sign out per person (`users.manage`; "You" for your own).
- [ ] **Tests first:**
  - Review Focus 5;
  - the tiles' figures and comparisons;
  - the chart's top 6 and today emphasis;
  - Sign out calls the existing `DELETE /users/:id/sessions`;
  - shown only with `audit.view`;
  - the e2e review copy of the Overview with activity, in both themes.
- [ ] **RED → GREEN →** suites, commit, push, CI, ledger.

### Task 4: Words, docs, review

- [ ] Audit words for `user.offboarded` (test first).
- [ ] `docs/runbooks/security.md` gains Offboarding and Security activity; the acceptance section; the changelog.
- [ ] One fresh reviewer over the whole 6C diff, one fix pass, and close the ledger. Then the Phase 6 summary for the owner, with every ruling.
