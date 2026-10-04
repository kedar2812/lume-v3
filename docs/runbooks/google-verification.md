# Google verification: the resubmission (October 2026)

On 2026-10-04 Google's Third-Party Data Safety Team sent LUME's verification back. They asked for:

- a video showing why each scope is needed, and why a narrower one won't do;
- the consent screen with every scope expanded;
- scopes in the app that exactly match the Cloud Console;
- a reviewer's sign-in with no blockers;
- step-by-step instructions.

**What changed in LUME:** Calendar now asks for `calendar.events.owned.readonly` instead of `calendar.events.readonly`. LUME reads events only on calendars the person owns, never calendars shared with them. The list of calendars is filtered to the ones they own.

The full set LUME asks for:

| Scope | Flow | Why it's the narrowest |
|---|---|---|
| `drive.file` | Sheets: Settings → Integrations → Google Sheets | Only the file picked in Google's own Picker. Non-sensitive. |
| `calendar.events.owned.readonly` | Calendar: Calendar → Continue with Google | Read-only, and only calendars the person owns. `calendar.events.freebusy` gives busy times without guests, so LUME couldn't tell which meeting is with which lead. `calendar.events.public.readonly` covers public events only, and sales calls are private. |
| `calendar.calendarlist.readonly` | Calendar, the same consent | Lets a person choose which of their calendars LUME reads (a work calendar, say, and not a family one). Without it LUME could only read the primary calendar. Non-sensitive. |

The order to work in: 1 → 2 → 3 → 4 → 5 → 6. Steps 1, 3, 5 and 6 are yours (Google sign-ins and recording). Claude has done the code, the privacy page, and this script. Step 2's deploys run on your command.

## 1. Cloud Console (you, about 5 minutes)

1. Open https://console.cloud.google.com/auth/scopes?project=lumecrm-connect (Google Auth Platform → **Data Access**).
2. Remove `.../auth/calendar.events.readonly`.
3. **Add or remove scopes** → filter for `calendar.events.owned.readonly` ("See the events on Google calendars you own") → tick it → **Update**.
4. The list must now be exactly:
   - `.../auth/drive.file`
   - `.../auth/calendar.events.owned.readonly`
   - `.../auth/calendar.calendarlist.readonly`
5. In the justification box for `calendar.events.owned.readonly`, paste:

   > LUME is a lead management app. A salesperson connects their own Google Calendar so their meetings with leads appear on those leads in LUME (for example, a call booked with someone in their pipeline). LUME needs each event's time, title and guests to match a meeting to a lead by the guest's email address. It never creates, changes or deletes events, and keeps only events that match a lead; all other events are read only to check for a match and are never stored. We chose calendar.events.owned.readonly because it is read-only and limited to calendars the person owns: calendar.events.freebusy returns no guests, so LUME could not tell which meeting is with which lead, and calendar.events.public.readonly covers only public events, while sales calls are private.

6. **Save**. Leave the app **In production**.

## 2. Deploy the app, the relay and the site (three commands, from the repo on your PC)

Afterwards, the relay at connect.lumecrm.in asks for exactly the three scopes above. app.lumecrm.in runs the latest LUME (all phases through 8), and https://lumecrm.in/privacy names `calendar.events.owned.readonly`.

```bash
# 1. The privacy policy and homepage on lumecrm.in
cd "F:/projects kedar/lume-site" && npx vercel@latest deploy --prod --yes

# 2. app.lumecrm.in: build, migrate, restart (keeps its data). Takes a few minutes.
cd "F:/projects kedar/lume v3" && bash scripts/dev.sh up

# 3. The relay: copy the fresh build (step 2 put it in src) into its folder, rebuild, restart
ssh lumedev 'cd /root/lume-dev && docker run --rm -v /root/lume-dev/src:/repo -v lumedev_pnpm_store:/pnpm-store -e npm_config_store_dir=/pnpm-store -w /repo lumedev-toolbox:latest bash -lc "pnpm --filter @lume/connect build" && cp -r /root/lume-dev/src/apps/connect/dist/. /root/lume-connect/dist/ && cd /root/lume-connect && docker build -q -t lume/connect:latest . && docker compose up -d && sleep 3 && curl -s https://connect.lumecrm.in/healthz'
```

The last command should end with `{"status":"ok"}`.

## 3. The reviewer's account and sample leads (you, about 10 minutes, at https://app.lumecrm.in)

Signed in as yourself:

1. **Settings → Integrations → Google Calendar:** make sure it's switched **on**.
2. **Settings → People → Invite:**
   - name `Google Reviewer`;
   - email `google-review@lumecrm.in` (it never needs to receive mail);
   - role **Sales**.

   Then choose **Copy link**. Sales doesn't require two-step sign-in, so nothing blocks the reviewer.
3. Open the copied link in a **private window**, set a strong password, and agree to the terms. Keep the password for the reply email only: never in the repo or chat logs.
4. Back in your own window, add three fictional leads with **Owner: Google Reviewer**:
   - Asha Verma, `asha.verma@example.com`
   - Rohan Mehta, `rohan.mehta@example.com`
   - Sara Khan, `sara.khan@example.com`

   (`example.com` is reserved for examples, so no real person gets an invitation.)
5. Sign in to the private window as the reviewer once: you see the three leads, and **Calendar** in the sidebar. That's all Google needs.

## 4. Dry run before recording (you, 5 minutes)

The first real check of the narrower scope against Google:

1. Go to https://myaccount.google.com/connections, find **LUME** and **remove its access**, so Google shows the full consent screen again.
2. In LUME, if your calendar is already connected: **Settings → Calendar → Disconnect**.
3. Run through scenes 3–6 of the script below once. If the meeting doesn't appear after Refresh, stop and tell Claude what you saw.

## 5. The video (you, 4–6 minutes, one take is fine)

Record the whole browser window **with the address bar visible**: Google checks the `client_id` in the URL on the consent screen. Use your own admin account; the reviewer's account is for Google's own test. Narrate, or add short captions, saying the lines in quotes.

**Scene 1. What LUME is (15 s).**
- Open https://app.lumecrm.in and sign in.
- "LUME is a lead management app for sales teams. This video shows each Google permission LUME asks for, and the feature that uses it."

**Scene 2. A lead (15 s).**
- Open **Leads** and click **Asha Verma** (or any lead you own with an email).
- "LUME matches calendar meetings to leads by the guest's email address."

**Scene 3. Connect Google Calendar (60 s). The consent screen matters most.**
1. Click **Calendar** in the sidebar, then **Continue with Google**.
2. Pick your Google account.
3. On Google's consent screen:
   - point at the app name **LUME**, and at `client_id=` in the address bar;
   - if Google shows "Select what LUME can access", **click each permission's text** so its full description shows;
   - if it shows "Show all" or "Show all services", click it.
4. Hold for 3 seconds on each permission:
   - **"See the events on Google calendars you own"**: "LUME reads events on calendars I own, read-only, to find meetings with my leads. It can't read calendars others share with me."
   - **"See the list of Google calendars you're subscribed to"**: "So I can choose which of my calendars LUME reads."
5. Tick both, then click **Continue**.

**Scene 4. Choosing calendars: `calendar.calendarlist.readonly` (30 s).**
- Back in LUME, the connection completes. Open **Settings → Calendar**.
- Point at **Calendars LUME reads**: "This list comes from Google, filtered to calendars I own. I choose which ones LUME reads." Turn one switch off and on.

**Scene 5. A meeting with a lead: `calendar.events.owned.readonly` (90 s).**
1. In a new tab, open https://calendar.google.com.
2. Create an event tomorrow at 11:00, titled "Intro call", with guest `asha.verma@example.com` (Asha's email). Save it, and choose "Don't send" if Google offers to email the guest.
3. Create a second event, "Dentist", with no guests.
4. Back in LUME → **Calendar** → **Refresh**.
5. "Intro call" appears as a meeting with **Asha Verma**. Click it, then open Asha's lead: the meeting is there too.
6. "The Dentist event has no lead as a guest, so LUME read it only to check for a match, and didn't keep it." Show it isn't in LUME's Calendar.
7. "LUME never creates, changes or deletes events. Everything is read-only."

**Scene 6. Disconnect (20 s).**
- **Settings → Calendar → Disconnect**, then confirm. "Disconnecting removes LUME's access and the meetings it kept."

**Scene 7. Google Sheets: `drive.file` (60 s).**
1. **Settings → Integrations → Google Sheets → Continue with Google**.
2. On the consent screen, hold on the permission ("See, edit, create and delete only the specific Google Drive files you use with this app"). "LUME gets only the file I pick."
3. Google's Picker opens: pick a sheet of sample leads (copy `docs/demo/sample-leads.csv` into a new Google Sheet first).
4. Back in LUME the sheet is connected, and its rows come in as leads. "LUME can't see any other file in my Drive."

**Upload:** YouTube, **Unlisted**. Copy the link.

## 6. Reply to Google's email (you)

Reply **in the same thread** (don't start a new one). Fill in the two `[…]` parts:

> Hello Third-Party Data Safety Team,
>
> Thank you for the review. We have made the following changes:
>
> 1. Narrower scope: LUME no longer requests calendar.events.readonly. It now requests calendar.events.owned.readonly, so it reads events only on calendars the user owns, read-only. The calendar list LUME shows is filtered to calendars the user owns. The app's scopes now exactly match the Cloud Console: drive.file, calendar.events.owned.readonly and calendar.calendarlist.readonly.
>
> 2. New demonstration video: [YouTube link]
>    It shows the consent screen with each permission expanded, and then each scope in use:
>    - calendar.calendarlist.readonly: the user chooses which of their own calendars LUME reads (Settings → Calendar);
>    - calendar.events.owned.readonly: an event with a lead as a guest appears as a meeting on that lead; an event without a lead is not kept;
>    - drive.file: the user picks one spreadsheet in Google's Picker and its rows become leads.
>
> 3. Why narrower scopes can't be used: LUME needs each event's time, title and guests to match a meeting to a lead by email address. calendar.events.freebusy returns no guests, and calendar.events.public.readonly covers only public events, while sales meetings are private. LUME never creates, changes or deletes events, and stores only events that match a lead.
>
> Test credentials (no two-step verification, no phone or card needed):
> - App: https://app.lumecrm.in
> - Email: google-review@lumecrm.in
> - Password: [the password you set]
>
> Steps to test:
> 1. Open https://app.lumecrm.in and sign in with the credentials above. You will see three sample leads, among them Asha Verma (asha.verma@example.com).
> 2. Click Calendar in the left sidebar, then "Continue with Google". Sign in with any Google account and allow both permissions.
> 3. You return to LUME. Settings → Calendar lists the calendars you own; choose which ones LUME reads.
> 4. In Google Calendar (same Google account), create an event within the next 7 days with asha.verma@example.com as a guest.
> 5. In LUME, open Calendar and click Refresh. The event appears as a meeting with Asha Verma, and on her lead (Leads → Asha Verma). Events without a lead's email as a guest are not shown or kept.
> 6. To disconnect: Settings → Calendar → Disconnect.
>
> Privacy policy: https://lumecrm.in/privacy
>
> Best regards,
> Kedar Uttam Gurav, LUME

## If Google comes back again

- Read which scope they name. If it's `calendar.calendarlist.readonly`, the fallback is to drop it and read only the primary calendar. That's a small code change in `apps/connect/src/relay.ts` and `apps/api/src/modules/calendar/google.ts`, with the choose-calendars list showing only the primary.
- Keep the 100-person cap in mind until it's through: the reviewer and you each count once.
