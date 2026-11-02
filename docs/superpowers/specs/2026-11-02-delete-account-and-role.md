# Deleting an account, and deleting a role (owner, 2026-11-02)

Two things LUME can't do today. A person can't delete their own account; an admin can only offboard someone (disabled,
kept for the record, never able to come back under the same email). And deleting a role only offers "choose a
replacement", from a Delete button that failed outright for a role nobody held (fixed 2026-11-02).

## What the owner asked for

- **Every person can delete their own account.** LUME asks what happens to their leads, asks for their password twice,
  and says plainly that the account will be deleted and that this can't be undone.
- **Deleting a role is the top of the hierarchy.** Its people are asked to be moved to another role, given a new role
  made there and then, offboarded, or have their accounts deleted. The password is required, every time. The UI is
  beautiful, in both themes.

## What "deleted" means

A deleted account is the person forgotten, the business's record kept (as the first Meta reviewer was deleted by hand
on 2026-11-02):

1. Everything offboarding does, in the same transaction: signed out everywhere, their leads handed on (a person, a team
   spread by load, or unassigned), open follow-ups with their leads, their Google Calendar disconnected, their open
   security alerts settled.
2. Then their person erased: name "Former member", email `deleted-<id>@deleted.lume.invalid` (their real address free
   to be invited again), password, two-step, recovery codes, preferences, time zone, avatar (the file too), roles and
   team memberships removed.
3. Status `deleted` (a new status; migration): never counted in places, never listed in People, never enabled again,
   never offered as someone to hand leads or follow-ups to.
4. What they did stays as done by "Former member": activities, notes, stage moves, sent messages, audit entries.
5. Audit `user.deleted` (by whom: themselves or an admin), with the leads choice and counts, never their old email.

## Who may, and the guards

| Case | Answer |
|---|---|
| The business owner deletes themselves | Refused: "The business owner's account can't be deleted. Make someone else the owner first." (ownership transfer is its own feature; until then the copy says to contact LUME support) |
| The last person who can manage people deletes themselves | Refused: someone must still be able to run LUME |
| Password typed twice, not the same | Refused before the server is asked: "The two passwords aren't the same" |
| Wrong password | Refused, counted like a failed sign-in (rate limit, alert after repeats) |
| Two-step on | The six-digit code too (a stolen session plus a guessed password isn't enough) |
| Leads to a person who is disabled / deleted / themselves | Refused: "Pick someone active to take the leads" |
| Leads to a team with nobody active | Refused: "Nobody active in that team can take the leads" |
| No leads at all | The leads step is skipped |
| An admin deletes someone else | users.manage + the admin's own password; same steps; the owner can never be deleted by anyone |
| Deleted in the middle of a request of theirs | Their session is revoked inside the transaction; the next request is signed out |
| A pending invite to the deleted address | Untouched (an invite is its own thing); a new invite works because the email is free |
| LUME AI runs they started | Ended (their runs speak as them); runs speaking as them started by others: paused with words |
| WhatsApp number they own ("whose number": them) | Becomes the business's |
| Demo mode | Deleting accounts is off in the demo (Settings shows why) |

## Deleting a role

| Case | Answer |
|---|---|
| Who | The owner, or someone with both roles.manage and users.manage (it can offboard and delete people) |
| Password | Always, even for a role nobody holds |
| Nobody holds it, nothing uses it | Password, then gone |
| People hold it | For them, one of: move to another role · a new role made here (name, starts as a copy of this one's access, editable after) · offboard (leads choice as offboarding) · delete their accounts (leads choice; never the owner, never the actor) |
| Invites, templates, shared views use it | Moved to the replacement role (as today); with offboard/delete, the replacement for these is still asked |
| The actor holds the role themselves | They can move themselves, never offboard or delete themselves from here |
| Deleting would leave nobody able to manage people | Refused |

## The screens (Apple-design, both themes)

- **My account → Delete account**, at the foot, quiet until opened. A sheet in three short steps with a progress line:
  Your leads (who takes them; counts shown) → Your password (twice; the code if two-step) → Delete (red, with
  "This can't be undone. Your account is deleted and you're signed out."). Done: signed out to a calm "Your account is
  deleted" page.
- **People → a person → Delete account** for admins: the same sheet, worded for them.
- **Roles → Delete role**: a sheet that names who holds it (avatars, count), the four choices as large radio cards,
  each opening its own short detail (pick a role / name the new one / leads choice), then the password, then the red
  button that says exactly what will happen ("Delete Sales and move 3 people to Admin").

## Tests (written first)

API: every row above, each refusal by its code; the delete transaction rolls back whole on a failure at any step;
deleted people absent from People, assignee pickers, places count; their old email invitable; audit carries no email.
Web: the three steps, the mismatched passwords, the owner and last-admin refusals in words, both themes in e2e with
screenshots and axe. Mutation check on every guard.
