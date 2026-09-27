# LUME — Project instructions for Claude Code

LUME is a **general-purpose lead management product licensed to many clients**. It is not a custom app for any one business.

- Nupuur Patil's business is the first customer only. Never treat her workflow, integrations, funnel stages, or team as the product's defaults or requirements.
- Each client runs an isolated instance on their own server. Same codebase and Docker image for everyone; differences live only in `.env` and admin settings stored in the database.
- Never hardcode client names, sheet IDs, funnel stages, branding, or integrations. Make it configurable instead.
- Integrations (Google Sheets, Calendly, Google Calendar, email digest) are optional modules. The app must work with all of them off.
- No per-client forks or `if client == X` logic. A client request becomes a configurable feature for all clients.
- Demo and seed data must be generic and fictional.
- Lead data never leaves the client's server except to integrations that client enabled.

When unsure whether something is "for Nupuur" or "for LUME", assume it is for LUME and make it configurable.

See `docs/LUME_LICENSING_DEPLOYMENT_SPEC.md` for licensing, deployment, updates, and offboarding.
