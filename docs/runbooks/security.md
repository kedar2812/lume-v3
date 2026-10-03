# Security: the watch, access limits, the watermark, exports, offboarding and activity (Phase 6)

LUME watches for anyone taking more lead data than their work needs, tells the admins, and can pause that
person's access. Everything here is a setting in **Settings → Security** (people with `security.manage`; the
owner always). Nothing is tuned for one business.

## What LUME counts

Every counted act already writes an audit entry, and the rules count those entries:

| Rule | Counts | Window | Default |
|---|---|---|---|
| Contacts opened | each contact reveal (`lead.contact.reveal`) | the last 60 minutes, rolling | more than 30 → tell admins and pause |
| Different leads opened | each lead opened in the drawer or page (`lead.view`), **different** leads only | the last 60 minutes, rolling | more than 200 → tell admins and pause |
| WhatsApp send-queue runs | each run started (`queue.started`) | since the start of the business's day | more than 3 → tell admins |

- **Who is watched:** everyone who can't see every contact. Never the owner, and never anyone who holds
  "See full contacts" at "Everyone" scope: they gain nothing by scraping.
- **A drawer that refreshes** the same lead counts once; list pages never count.
- **The check runs twice:** at the act itself (so a burst is stopped at the act that crosses the line, not
  minutes later), and every 5 minutes as a safety net.
- **One alert per person, rule and window.** A second breach in the same window grows that alert rather than
  opening another.

## What a pause does

- The person's sessions end at once, on every device, and they can't sign in until an admin restores them.
  Their leads stay theirs.
- The act that crossed the line is refused: that contact, or that lead, is not shown.
- They see: **"Your access is paused. LUME noticed unusual activity on your account and let your admins know.
  They can restore your access."** No limits and no numbers are ever shown to the person being watched.
- Near a pause rule's limit (80% of it), they see one calm line, once an hour: "You've opened a lot of contacts
  this hour. LUME tells your admins when activity looks unusual."

## Reviewing an alert

Admins hear at once: a notification (with a HUD that rises live on the screen), and a line in their daily
email while an alert is open. **Settings → Security → Overview** lists open alerts and the last 30 days. An alert
shows the burst minute by minute, what LUME did, the person's usual day, and three answers:

- **Restore access:** it was work. They can sign in again, and counting starts afresh from now, so the same
  burst can't pause them twice. Every open alert of theirs is resolved.
- **Keep paused:** look into it first. They stay paused until someone restores them.
- **Dismiss:** for an alert that paused nobody ("tell admins" rules).

People also shows a paused person as **Paused**, with Restore access for those who manage security.
Offboarding a paused person (People → Offboard, below) resolves their alerts as offboarded. **Enable** never brings back a paused
person: that's Restore, so the alert is always answered.

## Access limits per role

Settings → Security → Access limits, per role:

- **When:** any time, the business's working hours (it follows Settings → Business as they change), or custom
  days and hours on the business's clock. Outside them, sign-in is refused and live sessions end.
- **Where:** anywhere, or only the networks listed (an address like `86.98.40.12`, or a range like
  `94.200.12.0/24`). "Add this network" adds the one you're on.
- **The owner is never limited.** LUME refuses to save limits that would sign *you* out right now, and says how
  to fix it.

## The on-screen watermark

A faint "name · email · date" across lead screens (the list, a lead, the board): for people who can't see every
contact (the default), for everyone, or for nobody.

**What it can't do, said plainly:** it can't stop a screenshot or a photo of the screen. It makes one traceable
to the person whose screen it was. Exports carry their own mark (below).

## Exports you can trace (Phase 6B)

People with "Export leads" (admins by default, with two-step sign-in) export **the current Leads view**: its
filters and its columns, never more than they can see (their own scope, masked contacts if theirs are masked,
no hidden fields). CSV or Excel, up to 25,000 leads in one file.

- **The mark.** Every file has a `LUME ref` column with the export's code (like `PX7Q-4MRA`) on every row, and
  one made-up lead only LUME recognises: a name like any other, an email at `example.invalid` (a domain that can
  never receive mail) and a phone in the range kept for fiction (+44 7700 900xxx), so nobody real is reached.
- **What LUME can promise, exactly:** a file that still has the code column *or* the check row traces to its
  export. A file where both were removed, or the rows were retyped by hand, can't be traced, and LUME says
  "No LUME export matches this file" rather than guessing.
- **No Email or Phone in the view, no check row.** The check row is found by its email or its phone, so a file
  with neither column leaves it out (it couldn't be traced). The `LUME ref` column still marks every row.
- **Masked stays masked.** Someone who sees masked contacts gets them masked in the file, custom contact fields
  (phone, email, Instagram) included. The check row itself is written in full: it's made up, and Trace matches it
  exactly.
- **24 hours.** The file is kept, encrypted, for 24 hours and then deleted; the record (who, when, what, the
  code, the check row) stays. Only the person who made it can download it. Every export and every download is in
  the audit log.
- **Trace a file** (Settings → Security → Exports): drop a CSV or Excel file found outside the business, or type
  a code. LUME reads it in memory and forgets it, and answers with whose export it was, when, what, every download
  with its device, and how it was recognised. A CSV of any export's size reads (Trace isn't held to an import's
  20,000 rows). An Excel file that would open to more than 50 MB is refused unread ("Save it as CSV"), so a
  crafted file can't exhaust the server's memory.
- **Imported back in:** if someone imports an export into LUME, the real leads come in and the check row never
  does: it shows in the import's problems as "A LUME export's check row: not a real lead". It's known by its
  email or by its phone alone (the fiction range reaches nobody real). The `LUME ref` column is always ignored.

## Offboarding someone (Phase 6C)

**People → Offboard** (for people with "Manage people") replaces Disable with one guided sheet. An alert offers
it too ("Offboard {Name}" among the answers), for admins who manage people. The sheet shows, before anything
happens:

1. **Sign them out everywhere:** how many live sessions they have.
2. **Hand on their leads:** shared across a team (their own teams first), each lead going to whoever has the
   fewest open leads at that moment, ties by name, with each colleague's share shown live; or all to one person;
   or left unassigned for an admin to hand out. Nobody paused or disabled ever receives leads.
3. **Disconnect their Google Calendar** (when connected): LUME stops reading it at once. Meetings linked to a
   lead go with the lead to its new owner (one copy if the new owner already has the same event); meetings with
   no lead are removed with the connection.
4. **Their last 30 days:** contacts opened, leads opened, exports and alerts, and their busiest day against
   their usual. Counts only, never a contact.

**Offboard {Name}** does it all at once, in one transaction: if any step fails, nothing changes. The steps then
tick in order with what each did, and the sheet can't be closed while it runs. Their open alerts are settled as
offboarded, and the audit log gets one `user.offboarded` entry listing every step. They can be enabled again
later, but sessions, the hand-over and the calendar connection aren't put back. The owner can't be offboarded,
and nobody can offboard themselves.

## Security activity (Phase 6C)

Settings → Security → Overview shows, under the alerts, for people who may read the audit log:

- **Today:** contacts opened (different leads per person, as the reveals rule counts them) and by how many
  people; leads opened, against the median day of the 14 before; exports this week; failed sign-ins today (and
  whose, when they're all one person's). Each figure opens the Audit log at that action and day.
- **Contacts opened, per person:** the six people who opened the most over 14 days, a bar a day on one shared
  scale, today in blue (amber when they had an alert today). Each total opens their entries.
- **Signed in now:** one row a person, yours first. **Sign out** ends every session of theirs (for people who
  manage people).

Days are the business's (Settings → Business), so a contact opened at 23:30 there counts on that day.

## Checking it

- The automated end-to-end test `apps/web/e2e/security.spec.ts` plays the whole story with a limit of 5.
- By hand: Settings → Security → Rules, set "Contacts opened" to 5 with "pause". As a Sales person, reveal six
  contacts: the sixth is refused and the paused card shows. As an admin, the HUD rises; Review → Restore. Set the
  limit back afterwards.
- Offboarding: `apps/web/e2e/security.spec.ts` offboards that person from People, their leads shared across a
  team, and checks the leads moved. By hand: People → Offboard someone with a few leads in a team; read each
  step's result; the audit log shows one "offboarded someone" entry.
- Security activity: the same spec opens Overview's figures and follows "Contacts opened today" to the Audit
  log, filtered to today.
