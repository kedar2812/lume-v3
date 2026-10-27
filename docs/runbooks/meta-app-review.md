# Meta App Review for LUME's WhatsApp connection

What to put in Meta's App Review form for the LUME app (App ID 1437289605181003), and the recordings it needs. LUME
asks for two permissions, as a Tech Provider: `whatsapp_business_messaging` and `whatsapp_business_management`. A
submission can't be edited once sent, so read it through before **Submit**.

## Before you start

1. **Business verification:** verified (2026-10-25).
2. **Tech Provider access verification:** submitted 2026-10-27; Meta replies within 5 days.
3. **The developer account:** developers.facebook.com must open the app (no "Account confirmation needed" screen).
4. **The relay at connect.lumecrm.in** runs a build with Embedded Signup v5 (main 402a3663 or later).
5. **Webhooks:** App Dashboard → WhatsApp → Configuration, subscribed to `messages`, `account_update`, `history`,
   `smb_app_state_sync` and `smb_message_echoes`.
6. **A business number connected:** LUME's own +91 97642 56655 (WhatsApp Business app), connected to app.lumecrm.in
   through Settings → Integrations → WhatsApp → Connect a WhatsApp number. Doing this also makes the API calls Meta
   counts as "test calls" for both permissions.
7. **A reviewer login** on app.lumecrm.in (an admin, without two-step sign-in, or with its code given in the
   instructions), made by the owner.

## whatsapp_business_messaging

**How LUME uses it (paste):**

> LUME is lead management software for small and medium businesses. A business connects its own WhatsApp Business
> number to LUME. LUME uses whatsapp_business_messaging to receive the messages the business's leads send to that
> number and show each one on the matching lead, so the sales team sees the whole conversation in one place; to send
> the team's replies to a lead from LUME inside the 24-hour customer service window; to send the business's own
> approved message templates to leads who asked to be contacted; and to show whether each message was delivered and
> read. Messages are sent only by the business's own team (or, if the business switches it on, by LUME AI on the
> team's behalf, inside the limits the business sets). Leads who reply "stop" are marked do not contact and are never
> messaged again.

**Recording (one take, about 2 minutes):**

1. Sign in to app.lumecrm.in. Open a lead whose phone is a test phone you hold.
2. Send a WhatsApp template from the lead (Send → WhatsApp → choose the approved template → Send).
3. Show the message arriving on the test phone.
4. Reply from the test phone. Show the reply appearing on the lead in LUME, with its time.
5. Type a reply in LUME's reply box and send it. Show it arriving on the phone, then "Delivered" and "Read" in LUME.

## whatsapp_business_management

**How LUME uses it (paste):**

> LUME uses whatsapp_business_management so a business can connect its WhatsApp Business number to its own LUME through
> Embedded Signup, and manage it there. After the business finishes Embedded Signup, LUME subscribes the business's
> WhatsApp Business Account to LUME's webhooks so replies reach the business's LUME, reads the number's display name,
> quality rating and messaging limit to show its health, and lists, submits and checks the business's message templates
> so the team can send approved templates to leads. For a WhatsApp Business app number, LUME asks once for the
> contacts and past chats the business chose to share, so each lead's history is complete. LUME never changes the
> business's WhatsApp profile and never connects a number without the business going through Embedded Signup itself.

**Recording (one take, about 2 minutes):**

1. Sign in to app.lumecrm.in as an admin. Settings → Integrations → WhatsApp → switch it on.
2. **Connect a WhatsApp number** → read LUME's notes → **Continue with Facebook**.
3. In Meta's popup: log in, choose the business, choose the WhatsApp Business app number, scan the code with the phone.
4. Back in LUME: the number shows as connected, with its name and health.
5. Templates: write a template, choose **WhatsApp approval**, submit it, and show its status in LUME.

## public_profile

Only the agreement. LUME never reads or keeps the Facebook profile (it's part of Facebook Login itself).

## Data handling (answers)

- **Data processors / service providers:** the hosting of each client's own LUME server (the client's own provider);
  the AI provider the client's LUME is set up with (such as Anthropic or Google), only when the client switches LUME
  AI on; LUME's connect relay (passes messages through in memory, keeps nothing).
- **Responsible entity:** LUME (sole proprietorship, India), hello@lumecrm.in.
- **Requests from public authorities:** LUME has not received any. Meta also asks which policies apply (for example,
  reviewing each request's legality and disclosing the minimum). The owner picks these; they are commitments.
- **Deletion:** a business disconnects its number in Settings and can ask for its data to be deleted at
  https://lumecrm.in/privacy#rights.

## Reviewer instructions (paste, after filling in the login)

> 1. Open https://app.lumecrm.in and sign in with: email `<reviewer email>`, password `<reviewer password>`.
> 2. Settings → Integrations → WhatsApp shows the connected number and how a business connects one (Continue with
>    Facebook opens Meta's Embedded Signup).
> 3. Leads → open "Meta Reviewer" → the WhatsApp tab shows the conversation; the reply box sends a message.
> 4. Templates shows the business's message templates and their WhatsApp approval status.
> The recordings show each permission end to end with a real WhatsApp Business app number.
