# WhatsApp W3b: what shipped (2026-10-19 to 2026-10-20)

Plans: `docs/superpowers/plans/2026-10-19-whatsapp-file-library.md` (W3b-1) and
`docs/superpowers/plans/2026-10-19-whatsapp-templates.md` (W3b-2). Spec: `docs/superpowers/specs/2026-10-18-whatsapp-replies-ai-design.md` §4.3.
Not deployed anywhere.

## W3b-1: the file library and file links

- **Settings → Files** (admins with `templates.manage`). Drop or choose files; rename in place; archive with Undo, and
  restore later. A file is kept once, in the same store as WhatsApp's own files.
- **Share by link.** `/f/<43 random characters>` with no sign-in. It works only while switched on and not archived;
  otherwise it answers the same 404 as an address that never existed. 60 opens a minute from one address, and opens are
  counted.
- **Reply box.** Attach → From this device / From your files. A library file is attached with nothing uploaded again.
- **Send sheet** (WhatsApp not connected): **Add a file** puts the file's name and link under the message.

## W3b-2: approved templates, beyond 24 hours

- **Template → WhatsApp approval.** Language; category, with what it costs; an optional library file at the top. What
  WhatsApp would turn down is shown live. Submit, then see each account's standing: with WhatsApp for review,
  approved, turned down and why, or edited since approval.
- **WhatsApp's answer** comes by webhook, with a 15-minute sweep as backstop. The submitter and the admins are told
  once.
- **Reply box outside the 24 hours** (or for a lead who never wrote): the approved templates in the lead's words, with
  what's missing and about what WhatsApp charges, then Send. It's queued like any reply from LUME: same statuses, and it
  counts as a send.
- **Monthly limit on paid messages:** the lower of the plan's (`plan3`) and the admin's own. A notice at 80%, and a
  stop at the limit.
- **Opt-out (131050)** is honoured: the lead is marked, and marketing templates are no longer offered for them.

## Waiting on the owner

- **Licence server deploy** so the plan's monthly limit reaches clients (`plan3`, migration `0009_paid_sends.sql`).
- **`LUME_META_APP_ID` on each client** that wants a file at the top of templates.
- **Verify against the real test number before the first client:** template review, the webhook fields
  (`message_template_status_update`, `template_category_update`), Meta's resumable upload, and sending a template with
  a document header.
