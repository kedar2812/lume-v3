# lumecrm.in — the product website (design)

Date: 2026-10-06. Owner's brief: "an actual proper product selling website for lumecrm.in … compelling … convince
visitors for an enquiry … lots of effects and animations", with the screens of real LUME "in action", never empty.
Approved direction: canvas https://claude.ai/artifact/WaomNeRFQWdS5PseyAGv3r — **A (Obsidian, cinematic)** as the
base, with B's light/dark and phone, and C's analytics section exactly as drawn.

Three pieces of work, in this order:

1. **Live-day captures** (LUME repo): the demo business gains a planted "today" and a capture run that photographs
   every screen the site shows, in both themes and on a phone.
2. **Enquiries in the licence dashboard** (LUME repo, `apps/licence`): somewhere real for an enquiry to land.
3. **The website** (repo `kedar2812/lume-landing-page-`, Vercel, lumecrm.in).

## 1. Who it's for, and what it must make them do

- **Visitor:** the owner or sales head of an Indian small or mid-size business with a sales team (studios, clinics,
  coaching, real estate, agencies, B2B services): leads from Instagram, website forms and walk-ins, followed up on
  WhatsApp, tracked today in Excel, notebooks and personal phones. Written for India first (₹, WhatsApp, Indian
  names), readable by anyone.
- **One goal:** an enquiry (the form), or a WhatsApp message to the owner. Every section ends near a way to do one.
- **No prices** anywhere (owner, 2026-10-06): CTAs are "Book a demo" and "WhatsApp us", never "See pricing".

## 2. What the market says (research, 2026-10-06)

- Indian SMEs take enquiries from 4–6 channels at once and mostly track them in spreadsheets with no reminders or
  ownership ([Trackolap](https://trackolap.com/blog/lead-management-system-for-indian-smes-2026)).
- Speed decides the sale: reaching a web lead within 5 minutes rather than 30 made qualifying it about 21× more
  likely (Oldroyd, MIT / InsideSales Lead Response Management study, 2007). Many popular speed-to-lead figures are
  unsourced ([Booked in Blue](https://bookedinblue.com/speed-to-lead-statistics/)); the site quotes only this study,
  with its source in a footnote.
- The owner's unspoken fear: a salesperson leaves and the leads leave with them, through personal phones and export
  buttons left on ([Krypto](https://www.kryptocybersecurity.com/what-if-your-top-salesperson-leaves-with-your-data/),
  [Act-On](https://act-on.com/learn/blog/3-ways-keep-departing-sales-reps-stealing-your-clients/)).
- Competitors (Kylas, LeadSquared, TeleCRM, Interakt, Zoho) sell WhatsApp-API inboxes with per-message charges on
  top; many teams want to keep the WhatsApp they already use
  ([Cleomitra](https://www.cleomitra.com/blog/top-10-whatsapp-crm-software-india-2026),
  [GroweOn](https://www.groweon.com/blog/top-10-best-crm-software-for-indian-msmes-2026/)).
- What converts: outcome headlines over feature headlines; demo forms of five fields or fewer; relevance within
  three seconds ([Instapage](https://instapage.com/blog/b2b-landing-page-best-practices),
  [Apexure](https://www.apexure.com/blog/b2b-saas-marketing-the-right-landing-page-strategy/)).

## 3. What LUME says about itself, strongest first

1. **No lead goes cold.** Today says who to contact; follow-ups set themselves by stage; a lead nobody touches comes
   back to its owner; speed to lead is measured.
2. **WhatsApp from your own number.** One tap opens a filled-in template in the person's own WhatsApp: no API
   setup, no per-message fees through LUME, keep the WhatsApp you have. A send queue works through 50 at a time.
3. **When someone leaves, your leads don't.** Roles decide who sees which leads; exports can be locked and need
   approval; every download is traceable; LUME alerts on unusual reading; offboarding hands a person's leads on.
4. **Your own LUME, on your own server.** No database shared with other businesses; integrations off until switched on.
5. **Every source in one list:** website and Instagram forms (webhooks, Zapier, Make), Google Sheets, Calendly,
   CSV/Excel import; duplicates caught, phone numbers fixed.
6. **Every rep gets their own dashboard; you see the whole team.** Each salesperson's own Today (their follow-ups,
   calls and day), and their own numbers — My numbers, My funnel, My timing: leads handled, speed to first contact,
   replies, wins, follow-ups done on time, goals with pace. The owner and team leads see the Team board: everyone's
   work and results side by side, who is falling behind, overdue follow-ups per person. Work becomes visible, so it
   gets done.
7. **Numbers that talk:** analytics in sentences ("LUME noticed"), goals with pace, the team board, a Monday email.
8. **On the phone too:** the same LUME on a phone, for reps in the field.
9. **Built for volume, measured:** Today in 8 ms and every Analytics board under 175 ms at a million leads; bulk
   actions on up to 50,000 leads with Undo (`docs/runbooks/performance.md`).

## 4. Honesty rules (binding)

- Every claim is something LUME does in production today. No integration is named that LUME doesn't have
  (IndiaMART, JustDial: not named). Third-party marks are their official, unmodified files (`public/brand`), the
  WhatsApp, Google Sheets, Google Calendar and Calendly ones LUME already ships; Zapier and Make by name only until
  their official files are added.
- Every screen is a real capture of LUME (§6). Illustrations built in code (the hero's motion, the WhatsApp bubble)
  are drawn from real screens and carry no invented figures.
- Numbers on the page are either measured (performance, cited above) or the demo business's own, and the demo's are
  never presented as results.
- The copy speaks as LUME, never a faceless "we"; never guesses a gender; no client names. The owner is named as
  LUME's founder in the enquiry section and the footer (© Kedar Uttam Gurav).
- The logo is `lume-mark.png` as it is, never redrawn.

## 5. The page

One long page at `/`, plus `/privacy` and `/terms` (moved verbatim from today's site, §9). Look: A's —
near-black ground (#07080B) in Dark, LUME's Porcelain in Light, LUME's one blue #2A5BFF in both, Geist for type,
generous size and negative tracking on headlines, translucent sticky nav. Motion follows the apple-design skill:
springs (critically damped by default), scroll-linked where it carries meaning, interruptible, everything reduced to
cross-fades under `prefers-reduced-motion`.

1. **Nav:** logo, section links, the theme switch **Auto · Light · Dark** (LUME's own control and words), Book a demo.
2. **Hero:** "Every lead, answered while it's still warm." Sub: LUME gathers leads from Instagram, your website and
   sheets, puts the next follow-up in front of the right person, and sends it on WhatsApp in one tap. Book a demo +
   WhatsApp us. Below, the live Today capture tilted back on a breathing blue glow; it tips upright as the page
   scrolls (scroll-linked rotateX 14° → 0, scale 0.94 → 1), with the WhatsApp bubble and a "new lead" card floating
   out of it.
3. **Sources strip:** the places leads come from, as chips; official logos where LUME ships them.
4. **The problem:** three short lines — leads in five places; replies days later; the best salesperson leaves with
   their phone — then the 5-minute study as a large figure ("21×") with its source footnoted. Lines reveal word by
   word as they scroll in.
5. **Follow-up + WhatsApp** (A's section): the Today/Up next capture with the WhatsApp bubble; three ticks (templates
   filled in; stage rules set the next follow-up; calls from your calendar on their lead).
6. **What your team does in LUME** (the actions, §5.1): a keyboard-led showcase — on the left the list of actions
   with their keys, on the right the capture of that moment; the list advances on scroll (sticky), or by click.
7. **A lead's day** (B's timeline): 9:02 a form is filled → 9:03 the right person knows → 9:05 WhatsApp in one tap →
   Thursday 4 pm the call, then won. Cards draw a connecting line as they enter.
8. **On your phone** (B's phone): the phone captures (Today, Leads, a lead) in a device frame, three phones fanning
   out on scroll; "Your reps carry LUME in their pocket."
9. **Every rep, their own dashboard:** a rep's Today and My numbers side by side with the owner's Team board
   ("Each rep sees their own day and numbers. You see everyone's."). Points: a personal Today; their own numbers and
   goal pace; the Team board with speed, replies, wins and on-time follow-ups per person; who has overdue work right
   now. The rep's capture slides in from the left, the Team board from the right, meeting in the middle.
10. **Analytics** — C's section exactly as on the canvas: the Analytics capture under a dark fade, "Analytics that
   read like a colleague's note.", and four insight chips. In Light the capture is the Porcelain one and the fade is
   light. The chips are LUME's real insight titles, worded as the demo business's (labelled "From the demo business").
11. **When someone leaves, your leads don't:** roles, locked exports with approval, traceable downloads (the trace
    tool capture), unusual-reading alerts, offboarding hand-off. Four cards, the security overview capture behind.
12. **Your own LUME + measured speed** (A's cards): own server; 1,000,000 leads tested; 8 ms Today; 50,000 per bulk
    action with Undo. Numbers count up once when they enter.
13. **FAQ** (objections): Do I need the WhatsApp Business API? (No — LUME opens your own WhatsApp.) Can I bring my
    Excel? (Yes — import, duplicates caught.) Where does my data live? (On your own server.) Will my team use it?
    (Today is one screen of what to do; the phone layout.) Can my reps see everyone's leads? (Only what their role
    allows.) Can I see how each rep is doing? (Yes — the Team board; each rep sees their own numbers.) How do I try it? (Book a demo.) Disclosure buttons; one open at a time.
14. **Enquiry** (A's blue panel): "See LUME on your own leads." Five fields — your name, business, WhatsApp number,
    email (optional), team size — and "How do leads reach you today?" as one optional line. Book my demo; beside it
    "Or message +91 88058 95066" on WhatsApp.
15. **Footer:** © 2026 LUME · Kedar Uttam Gurav; the Google API Limited Use statement; Privacy, Terms.

### 5.1 The actions (real, each with its capture)

| Action | Key | Capture |
|---|---|---|
| Send a WhatsApp template, filled in | W | lead drawer, WhatsApp menu open |
| Log a call and how it went | C | Log a call open |
| Set the next follow-up (snooze, repeat, remind) | F | follow-up sheet |
| Win a deal (value, package, the celebration) | — | Won popover |
| Assign everyone who matches, with Undo | — | bulk island, "Assign 12,408 to …" |
| Message 50 leads one after another | P / S | send queue run |
| Drag a deal to the next stage | — | pipeline board |
| Find anyone by name, phone or email | Ctrl K | search open |
| Open exactly the leads behind any number | — | analytics drill sheet |

## 6. Live-day captures (LUME repo)

- **The business:** the demo seed (`apps/api/src/demo/seed.ts`), in ₹ and Asia/Kolkata for the capture run (set in
  settings before seeding), seed fixed so the captures are repeatable.
- **The live day** (new, `seedLiveDay(pool, { now, userId })`, generic and fictional, also for demo.lumecrm.in
  later): for the owner and for one rep (each their own day; the rep's within their own leads) — 2 overdue follow-ups, 3 due within two hours, 4 later today, 3 done this
  morning; 2 calls today (one held and logged, one at 4 pm); 3 leads waiting for someone; WhatsApps sent this morning
  with 2 replies; a deal won at 11:40. Today, the bell and Analytics then all read as a working day.
- **The run:** a Playwright project `site-captures` (beside `design-review`), captured at 10:45 am business time, at
  1440 × 900 with device scale 2, Porcelain and Obsidian, plus 390 × 844 phone captures; the phone column hidden in
  Leads (the demo's numbers are fictional UK ones); action states opened by the real keys and clicks. Output: WebP
  files named `<screen>-<theme>.webp` handed to the website repo's `public/screens/`. Nothing is retouched.
- **Captures:** today (owner), today (a rep), my numbers (a rep), team board, leads, lead drawer, the nine action states (§5.1), pipeline, calendar week, analytics
  overview, team board, security overview, export trace, phone today / leads / lead.

## 7. Enquiries in the licence dashboard (LUME repo, `apps/licence`)

- **Table** `enquiries`: id, created_at, name, business, whatsapp, email (nullable), team_size, how (nullable),
  source ('website'), status ('new' | 'contacted' | 'demo_booked' | 'won' | 'not_a_fit'), notes, updated_at.
  Migration `0003_enquiries.sql`.
- **Intake** `POST /v1/enquiries`: bearer token (`ENQUIRY_TOKEN`, in the licence server's secrets and the website's
  Vercel env; generated on the server, never printed), body validated with zod and size-capped, rate-limited by IP and
  globally (lib/limit), duplicates within 10 minutes (same WhatsApp number) folded into one. 201 with the id.
- **Panel:** Enquiries in the sidebar with a count of new ones; a list (newest first, status filter), and each
  enquiry with its details, a status control, notes, and "WhatsApp" / "Email" buttons that open the owner's own apps.
  The panel's existing session and audit rules apply.

## 8. The website (repo `lume-landing-page-`)

- **Stack:** Next.js (the version LUME uses) with the App Router, TypeScript, CSS modules and tokens like LUME's;
  `motion` for springs and scroll-linked motion; Lenis smooth scrolling (off under reduced motion); Geist from
  `next/font`. Static pages; one route handler.
- **Theme:** `data-theme` on `<html>` from Auto (system) / Light / Dark, remembered in localStorage (try/catch), set
  before first paint by an inline script so nothing flashes. Every capture is a pair; CSS shows the one for the
  current theme (both `loading="lazy"` except the hero's, which is preloaded for the default theme).
- **Enquiry flow:** the form posts to `POST /api/enquire` (route handler). It validates (zod), drops bots (a hidden
  honeypot field and a minimum time on page), then independently (a) files it at
  `https://license.lumecrm.in/v1/enquiries` with `ENQUIRY_TOKEN`, and (b) emails it through Resend to
  `ENQUIRY_TO` (an env value, not on the page). Success if either worked: the form turns into "LUME's founder will
  message you on WhatsApp soon." If both failed, the page opens WhatsApp to +91 88058 95066 with the visitor's
  details already written, so no enquiry is lost. Inline validation; errors in words.
- **Config, never code:** WhatsApp number, enquiry email, licence URL and token, Resend key — environment variables;
  the WhatsApp number is also public (`NEXT_PUBLIC_WHATSAPP`).
- **SEO:** title "LUME — lead management for teams that sell on WhatsApp", description, Open Graph image (the hero
  composition), sitemap, robots, `SoftwareApplication` structured data with no price.
- **Budgets:** LCP ≤ 2.5 s on a mid-range phone over 4G, CLS ≤ 0.05, JS ≤ 180 KB gzipped on `/`, images WebP sized to
  their box; axe clean in both themes; every control keyboard-reachable; text contrast ≥ 4.5:1.

## 9. Google verification continuity

- `/privacy` and `/terms` move verbatim from `F:/projects kedar/lume-site` (same URLs); the homepage keeps describing
  LUME, links both, and carries the Limited Use statement; the name and logo match the consent screen.
- **Switch-over after the owner records the verification video:** the new Vercel project is built and reviewed on its
  preview URL; lumecrm.in and www move from the `lume-site` project to it only on the owner's say-so (no DNS change:
  both are Vercel).

## 10. Testing

- Licence: intake tests (token, validation, rate limit, fold duplicates), panel tests, migration test.
- Website: unit tests for the form's validation and the route handler (either path succeeding; both failing → the
  WhatsApp fallback; honeypot); Playwright over the page in both themes and at phone width (theme switch swaps every
  capture, no horizontal scroll, reduced motion respected), axe, and a Lighthouse budget check.
- Captures: the run fails if any listed capture is missing or shows an empty state the live day should have filled.

## 11. Not now

Prices; a blog; demo.lumecrm.in itself (the live day is built so it can use it); languages other than English;
video clips of the actions (static captures with motion first).

## 12. The owner's part

- Create a Resend account, verify lumecrm.in in it (DNS records Resend gives), and put the key into the new Vercel
  project — or say so and Claude walks through it; Claude never handles the key.
- Say when the domain may move (after the recording).
- Later: the official business email replaces the personal one in `ENQUIRY_TO`.
