# Calendly

A client's Calendly can send its bookings to their LUME. Calendly is an optional module: it's off until an admin connects it, and LUME works the same without it.

**What a booking does:**
- It finds the lead by email, then by phone, or makes one.
- It keeps the meeting.
- It moves the lead to its pipeline's "on booking" stage, and that stage's automations run.
- It tells the lead's owner.

**What a cancellation does:**
- It marks the meeting cancelled and tells the owner.
- It sets a "Reschedule" follow-up.
- A Calendly reschedule leaves the old meeting marked rescheduled, and the new booking arrives on its own.

Nothing about this runs through the owner's servers: Calendly posts straight to the client's LUME.

## Before connecting

- **Calendly's plan:** Calendly sends bookings to other apps only on its **Standard plan or higher**. On a free plan, LUME says so when the admin tries to connect. Google Calendar can still find the meetings.
- **The client's LUME must be reachable** at its public address. Calendly posts to `https://<their LUME>/webhooks/calendly/<id>`.
- **Who connects:** ideally someone who administers the client's Calendly organization. LUME then receives every host's bookings. Anyone else connects only their own bookings, and Settings shows which.

## Connecting (the client's admin)

1. In Calendly, go to **Integrations → API & webhooks → Personal access tokens** and make a new token.
2. In LUME, go to **Settings → Integrations → Calendly**, paste the token and connect.
   - LUME checks the token, keeps it sealed, and asks Calendly to send it bookings and cancellations, signed with a key only LUME holds.
   - The token is never shown again.
3. In **Settings → Pipeline**, pick each pipeline's **on booking** stage (for example, "Call booked").
4. Optionally, in **Settings → Integrations → Calendly**:
   - **New leads:** on by default. Turned off, a booking from someone who isn't a lead yet keeps only the meeting, unlinked.
   - **Reschedule follow-up:** on by default.
   - **Phone question:** the booking question whose answer is a phone number, if Calendly's own SMS-reminder number isn't asked.

LUME makes new leads and moves them as the admin who last saved Calendly's settings.

## When something goes wrong

LUME checks every day, and at start, that Calendly is still sending. Any of the problems below shows Calendly as **needs attention** in Settings → Integrations, and on admins' Today.

| What Settings says | What to do |
|---|---|
| Calendly stopped accepting LUME's access token | Make a new token in Calendly, then disconnect and connect Calendly again. |
| Calendly stopped sending bookings to LUME | The plan or the connecting person's access changed. Connect Calendly again. |
| The person Calendly runs as can no longer add leads | Any admin who can add leads opens Calendly's settings and saves. The bookings that waited meanwhile go through. |

**Disconnecting** removes LUME's subscription at Calendly (if Calendly can be reached) and archives the source. Leads and meetings stay.
