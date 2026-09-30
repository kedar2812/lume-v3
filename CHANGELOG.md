# Changelog

Every LUME release, newest first. The version is the root `package.json`'s; tagging `vX.Y.Z` builds the
release images (`docs/runbooks/fleet.md`). Migrations are forward-only and additive: an update never drops a
column in the release that stops using it.

## 1.0.0 — 2026-10-01

The first release for clients.

- **Leads:** the pipeline, lists and board; custom fields, tags, owners; saved views; import from CSV and
  Google Sheets; webhooks (website forms, Zapier, Make).
- **Follow-ups:** tasks with reminders, automations on stage changes, the no-touch alert, working hours, the
  daily digest.
- **Messages:** WhatsApp templates and sending, and the send queue (50 a run, 150 a day by default).
- **People and access:** roles with scoped permissions, teams, two-step sign-in, recovery codes, sessions,
  the audit log.
- **Licensing:** each installation checks its licence with license.lumecrm.in (six numbers, never a lead),
  knows its state (active, grace, read-only, suspended), and enforces it in the API. Export all data works in
  every state.

### Migrations

- **0030 widens existing roles:** every role that can send messages (`messages.send`) is also granted
  `messages.send_queue` at the same scope, so Sales can run send queues. Remove it from a role in
  Settings → Roles if you don't want that.
- **0031** adds the licence's own state (`licence_state`, and `sessions.notice_dismissed`).
- **0032** adds `data.export`, granted to roles that change settings.
