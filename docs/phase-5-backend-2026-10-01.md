# Phase 5 backend, 1 Oct 2026 (day): Calendly, meetings in messages, and the Calendar rules API

Built while the owner was out ("continue with backend, we can discuss the frontend designs when i come home"), from the plan `docs/superpowers/plans/2026-10-01-phase-5bc-calendly-meetings-backend.md` and the spec `docs/superpowers/specs/2026-10-01-phase-5-calendar-design.md` §3–§4. No screens: they follow the owner's designs. A fresh review found 6 Important issues (and one Minor re-graded Important); all 7 are fixed, each with a test that failed first. CI is green on the fix pass (1ab3b0f).

## Every decision made for the owner

Each with what it costs if it was wrong.

- **Global:** the owner asked (2026-10-01, "can you continue with backend, we can discuss the frontend designs when i come home") for the backend to go on while they're away; the plan follows the spec's §3–§4 (a draft for the owner) and builds no screens — cost if wrong: backend tasks redone to a changed spec
- **Global:** the plan describes tests in prose; they are written in full, first (standing ruling since 3B) — cost if wrong: none
- **Task 1:** the endpoints live in the settings module (settings/calendar.ts beside follow-ups and messaging), not calendar/rules.ts as the plan named — that's where every Settings section is served — cost if wrong: a file move
- **Task 1:** "the sync reads the new rules" is proven by the stored shape (settings.calendar = { rules }) being exactly what the sync's tests write and read, not by a second relay-backed sync test — cost if wrong: none (one shape, one parser: calendarRulesSchema)
- **Task 2:** the booking stage must be one of that pipeline's open stages (a won or lost stage is refused as UNKNOWN_STAGE) — a booking is a step on the way, never an outcome — cost if wrong: one condition
- **Task 2:** archiving a stage clears it as a booking stage explicitly (an archive is soft, so the FK's ON DELETE SET NULL never fires) — cost if wrong: none
- **Task 3:** only organization scope refused as "forbidden" falls back to user scope; a "plan" refusal (403 saying upgrade) never falls back, and is said as the plan — cost if wrong: one more Calendly call
- **Task 3:** the fake signs deliveries with its own HMAC code (not LUME's), so the receive tests prove LUME's check against Calendly's documented scheme, not against itself — cost if wrong: none
- **Task 4:** a Calendly source's rules are made at connect (the default pipeline's first open stage, match on email then phone, merge, owner from the host's email else unassigned, the business's country) with no draft/mapping step — Calendly's booking always has the same four columns — cost if wrong: Settings gains a rules editor later (the source's rules are already the engine's own shape)
- **Task 4:** connecting holds a transaction-level advisory lock, so two admins connecting at once make one source and one subscription — cost if wrong: none
- **Task 4:** disconnect forgets even when Calendly can't be reached (the subscription is then left at Calendly, and its posts are refused as an archived source's) — cost if wrong: refused posts until Calendly's retries stop
- **Task 5:** Calendly's route sits in the same open scope as 2C's posts and shares its raw-body parser and licence guard (registered right after it), rather than a second scope with its own — cost if wrong: an order dependence in app.ts, said in a comment there
- **Task 5:** a delivery is keyed "<event>:<invitee URI>" (one booking, one cancellation of it); a signed post that isn't JSON is 400 and counted bad_json; another event is acknowledged (202 ignored) and never kept — cost if wrong: none
- **Task 6:** the lead, the meeting, the history and the stage move are one job transaction as the person Calendly runs as; the meeting row alone is written as its owner (row-level security asks that), switching lume.user_id for that statement and back — cost if wrong: none (all or nothing, retried by the queue)
- **Task 6:** the meeting's owner is the Calendly host when they're a LUME person, else the lead's owner, else the person Calendly runs as; the one told is the lead's owner (else the meeting's) — cost if wrong: a different person hears
- **Task 6:** with new leads switched off, a lead is matched by email (any case) then phone (the business's country), the oldest when two share one — the same keys the intake engine matches on — cost if wrong: none
- **Task 6:** a reschedule's cancel leaves the old meeting "rescheduled" with a history line and no notification or follow-up; the new booking arrives as its own invitee.created, which tells the owner as any booking does — cost if wrong: one more notice
- **Task 6:** a cancellation closes the meeting's open Log outcome follow-up (5A), as the final review's fix does for Google meetings — cost if wrong: none
- **Task 7:** "Thursday 1 October" and "10:30 am" ("12 pm" on the hour), on the business's clock, in English like the rest of LUME's message words — cost if wrong: a format change in one function
- **Task 7:** the picker's "needs Calendar" mark on meeting variables stays as it is (it's the screen's to change with the Calendar designs) — cost if wrong: none
- **Task 8:** the reminder is a WhatsApp follow-up (type whatsapp, the rule's template) for the lead's owner — never another person — due hoursBefore before the next meeting, never shifted into working hours (a reminder at 7 am for a 9 am call is the point); one open per rule per lead, as create_task — cost if wrong: one condition
- **Task 8:** task views now carry `type` and `templateId`, so the screen can open the send sheet with the template; no screen changes in this plan — cost if wrong: none (two more fields)
- **Task 9:** Today lists the caller's own meetings (as owner) starting today on their clock, leaving out cancelled and rescheduled ones (a rescheduled meeting's slot isn't happening; its new booking is listed) — cost if wrong: one status
- **Final:** the same helpers are not given to sheet, webhook and CSV-import jobs here — those are 2A–2C's (outside this plan), and a CSV import of thousands telling people about each lead would be a change in behaviour; a lead that arrives by any intake (Calendly included) never sends "assigned to you", which is the product's existing choice — cost if wrong: sheet and webhook booking stages' "clear follow-ups" leave reminders unread until the owner opens them
- **Final:** declined-to-judge — whether Calendly re-signs its retries with a new t (if not, a retry after 5 minutes is refused as stale): Calendly's documentation says each delivery is signed when sent; the owner's real-Calendly check before release covers it — cost if wrong: late retries refused
- **Final:** declined-to-judge — meeting variables use the business's zone, not the invitee's: spec §4 says the business's zone — cost if wrong: a format choice
- **Final:** declined-to-judge — a host who can't see the lead can't see their own meeting: 5A's row-level security as spec §2.4 sets it — cost if wrong: one policy
- **Final:** declined-to-judge — the booked notice's time is on the business's clock, not the recipient's: one clock for everyone in a business, as the digest's words are — cost if wrong: one zone
- **Final:** declined-to-judge — a reminder whose time has passed is skipped, not sent now (Ruling 40 stands): a late "see you soon" after the meeting is worse than none — cost if wrong: one condition
- **Final:** declined-to-judge — whether a non-admin's organization-scope refusal ever says "upgrade" (which LUME would read as the plan): Calendly's wording; the real-Calendly check covers it — cost if wrong: a non-admin is told about the plan instead of falling back to their own bookings

## Deferred minors (the review's, for the owner to decide)

- a booking stage that later becomes won or lost (its kind changed) isn't cleared as the booking stage
- Calendly's mapping gives the lead to the host, but neither connect nor processing checks leads.assign (every other intake path does)
- a data error in the meeting write runs asPerson's restore in an aborted transaction (25P02), so the post is retried for a day instead of recorded as a problem
- the replay table hashes the whole signature header, so a reordered or re-cased header counts as new (the event-key dedupe still stops a second meeting)
- a manual re-run merges the lead again (another history line) and, if the owner rule now picks someone else, the unique key lets a second meeting in
- a reminder rule's templateId isn't checked when the stage is saved, only when it runs
- test gaps — the reminder's already_open path; DUP1's deliveries share a second (the replayed-signature path, not the event-key one); the meeting-variable API test pattern-matches the time; "12 am" is untested
- a Reschedule follow-up is set even for a lead already won or lost
