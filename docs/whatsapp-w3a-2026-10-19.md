# WhatsApp W3a: Reply from LUME, what shipped (2026-10-19)

Spec: `docs/superpowers/specs/2026-10-18-whatsapp-replies-ai-design.md` §3.4 and §4.3 (within 24 hours).
Plan: `docs/superpowers/plans/2026-10-19-whatsapp-send.md`, with its 30 outcomes, each built and tested.
Canvas: https://claude.ai/artifact/XtskGooJPdv9SZHm9Koutd. Runbook: `docs/runbooks/whatsapp.md` → Reply from LUME.

The owner asked: "why not add the feature of sending messages via lume itself instead of always going to whatsapp".

## What a client's team sees

- **The switch.** Settings → Integrations → WhatsApp → **Reply from LUME**. An admin switches it on (it's off by
  default), and it says what it does.
- **The reply box on the lead's WhatsApp tab:**
  - "You can reply until 4:12 pm · From +91 90000 00001". It names the person when the number is someone's own.
  - Enter sends on a computer, Shift+Enter makes a new line. The box grows to six lines.
  - **Attach** takes a photo, video, voice note or document. The file shows arriving, then its name and size, with
    a place for words.
- **A message sent from LUME:**
  - it rises into the thread and says who sent it;
  - then Sending…, Sent, Delivered, Read (blue), changing by themselves;
  - if it didn't go, the reason in words, with Try again.
- **After WhatsApp's 24 hours:** the reason, and the usual **Message** button that opens WhatsApp on the device.
- **It counts as a send** once Meta takes it: the lead's last message, first contact (speed to lead), the follow-up
  done, and the stage's move. All of it is recorded as the person who sent it.

## Strong at 1,000 people

- Eight sending workers. Busy or rate-limited answers from Meta are tried again with backoff.
- 30 messages a minute and 600 an hour for each person.
- A brochure is uploaded to Meta once per number and content, then reused for 25 days, however many leads get it.
- One query for every message's status on a thread. The thread shows the newest 500 messages.

## Never twice, never lost

- **Each message has its own key.** A double tap, a retry or two tabs make one message.
- **A crash mid-send is never sent again by itself.** It's marked "LUME couldn't tell whether this went. Check the
  phone before sending it again."
- **A message a lost job left behind is found again by the minute sweep.**
- **Statuses only move forward.** A late "sent" or a repeat changes nothing.

## Security

- The file's type is read from its bytes, never its name: an HTML page called `.pdf` is refused.
- WhatsApp's size for each kind is enforced, and a file attached to one lead can't be sent to another.
- Sending checks permission twice: when Send is tapped, and again when the queue sends, as that person.
- Outbox rows are seen exactly as their lead is (row-level security), and every new route is in the access matrix.
- Meta's error text is never logged, only its code.

## Found and fixed along the way

- **The thread showed a long chat's oldest 500 messages, not its newest** (W1). Fixed, with a test.
- **First contact was never recorded for a team that only replies from LUME.** "Yes, sent" now counts as first
  contact too (migration 0076). For tap-to-send nothing changes.

## Rulings

The full list, with what each costs if wrong, is in the ledger (`.superpowers/sdd/2026-10-19-whatsapp-send/progress.md`)
and in the final report.

## Next

- **W3b:** messages after the 24 hours, sent with Meta-approved templates (with media), with each send's cost shown.
- **W2:** reply meaning via LUME AI; stop → do not contact; the Who replied board; Today's Replies tile.
- Everything here still needs checking against the owner's real Meta test number (runbook "verify" list).
