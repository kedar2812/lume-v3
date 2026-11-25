import type { FlowGraph, GNode, Next } from "./graph";

/**
 * The ready-made flows (owner 2026-11-25; plan 2026-11-23-flow-builder Task D7, plan 2026-11-25-instagram-screens D4):
 * the flows businesses use most on Instagram, each a graph that opens on the canvas ready to change. Generic names and
 * LUME's own words only. What only the business knows is left for it: links empty, and words to write marked [[…]]
 * (validateGraph refuses both until they're filled). A tag is named "#label": LUME finds or makes that tag when the
 * flow is made. Inside Instagram's rules: nothing waits past its 24 hours, nothing promises a message later, and
 * nothing checks who follows you (Instagram tells no app).
 */
export type ReadyGroup = "leads" | "sell" | "answer" | "events";
export type ReadyKind = "comment" | "dm" | "story_reply" | "story_mention" | "ad" | "welcome";
type ReadyDef = {
  group: ReadyGroup;
  name: string;
  /** One line on its card. */
  what: string;
  /** Why businesses use it, in the preview. */
  why: string;
  /** What starts it, in words. */
  starts: string;
  /** What it starts on, as the flow's first way in (its keywords may be changed before it goes live). */
  trigger: { kind: ReadyKind; keywords: string[] };
  /** What the business fills in before it can go live, or that it's ready. */
  fill: string;
  /** Its steps in a few words each, for the preview: what kind of step, and what it does. */
  preview: [string, string][];
  graph(): FlowGraph;
};

export const READY_GROUPS: { id: ReadyGroup; label: string }[] = [
  { id: "leads", label: "Get leads" },
  { id: "sell", label: "Sell" },
  { id: "answer", label: "Answer questions" },
  { id: "events", label: "Events" },
];

/** Where a step sits on the canvas: its column and row (the builder's Tidy up can lay it out again). */
type At = [col: number, row: number];
const COL = 320;
const ROW = 190;
function g(start: string, ...steps: [GNode, At][]): FlowGraph {
  return {
    v: 2,
    start,
    nodes: steps.map(([n]) => n),
    pos: Object.fromEntries(steps.map(([n, [c, r]]) => [n.id, { x: c * COL, y: r * ROW }])),
    notes: [],
  };
}
const msg = (
  id: string,
  text: string,
  o: { next?: Next; buttons?: [string, string][]; replies?: [string, Next][] } = {},
): GNode => ({
  id,
  type: "message",
  text,
  buttons: (o.buttons ?? []).map(([title, url], i) => ({ id: `${id}-b${i + 1}`, title, url })),
  replies: (o.replies ?? []).map(([title, next], i) => ({ id: `${id}-r${i + 1}`, title, next })),
  next: o.next ?? null,
});
const ask = (
  id: string,
  text: string,
  save: { field: string; kind: "text" | "email" | "choice" },
  o: { next?: Next; choices?: [string, Next][]; retry?: string } = {},
): GNode => ({
  id,
  type: "ask",
  text,
  save,
  ...(o.choices
    ? { choices: o.choices.map(([title, next], i) => ({ id: `${id}-c${i + 1}`, title, next })) }
    : {}),
  retry:
    o.retry ??
    (save.kind === "email"
      ? "That doesn’t look like an email. Could you check it?"
      : save.kind === "choice"
        ? "Tap one of the options above."
        : "Could you say that another way?"),
  next: o.next ?? null,
  noAnswer: { afterMinutes: 0, next: null },
});
const tag = (id: string, label: string, next: Next = null): GNode => ({
  id,
  type: "update",
  actions: [{ kind: "tag", tagId: `#${label}`, add: true }],
  next,
});
const tell = (id: string, text: string, next: Next = null): GNode => ({
  id,
  type: "notify",
  to: "owner",
  text,
  next,
});
const hand = (id: string, note: string): GNode => ({ id, type: "handoff", to: "person", note });
const book = (id: string, text: string, next: Next = null): GNode => ({
  id,
  type: "book",
  text,
  url: "",
  next,
});
const wait = (id: string, minutes: number, next: Next): GNode => ({
  id,
  type: "wait",
  for: { minutes },
  next,
});

const LINK = "Add your link before it goes live.";
const READY_AS_IS = "Ready as it is. Change any words you like.";

export const READY_FLOWS = {
  comment_link: {
    group: "leads",
    name: "Link for a comment",
    what: "Someone comments a word; they get the link in a DM.",
    why: "The most used of all: a reel says “comment LINK” and every comment gets a private reply.",
    starts: "Someone comments “LINK”",
    trigger: { kind: "comment", keywords: ["LINK"] },
    fill: LINK,
    preview: [
      ["Private reply", "Here’s the link you asked for. Tap below and it’s yours."],
      ["Send a message", "The link, as a button"],
    ],
    graph: () =>
      g(
        "pr",
        [
          msg("pr", "Here’s the link you asked for. Tap below and it’s yours.", {
            replies: [["Send me the link", "link"]],
          }),
          [0, 0],
        ],
        [msg("link", "Here you go!", { buttons: [["Open the link", ""]] }), [0, 1]],
      ),
  },
  comment_freebie: {
    group: "leads",
    name: "Freebie for a comment",
    what: "A guide or checklist, after an email.",
    why: "Asks for an email before the freebie, so every comment can become a lead you can reach again.",
    starts: "Someone comments “GUIDE”",
    trigger: { kind: "comment", keywords: ["GUIDE"] },
    fill: "Add the guide’s link before it goes live.",
    preview: [
      ["Private reply", "Want the guide? Tap below."],
      ["Ask", "Their email, saved on the lead"],
      ["Send a message", "The guide’s link"],
      ["Update the lead", "Tagged “guide”"],
      ["Tell your team", "A new lead from the guide"],
    ],
    graph: () =>
      g(
        "pr",
        [
          msg("pr", "Want the guide? Tap below and it’s yours.", {
            replies: [["Send me the guide", "email"]],
          }),
          [0, 0],
        ],
        [
          ask(
            "email",
            "What’s your email, in case there’s more you’d like?",
            { field: "email", kind: "email" },
            { next: "give" },
          ),
          [0, 1],
        ],
        [
          msg("give", "Here it is. Enjoy the guide!", { buttons: [["Open the guide", ""]], next: "tag" }),
          [0, 2],
        ],
        [tag("tag", "guide", "tell"), [0, 3]],
        [tell("tell", "A new lead from the guide."), [0, 4]],
      ),
  },
  story_reply: {
    group: "leads",
    name: "Story reply",
    what: "Thanks them and asks what caught their eye.",
    why: "Replies to stories are warm: a quick answer keeps the talk going while they’re still looking.",
    starts: "Someone replies to any story",
    trigger: { kind: "story_reply", keywords: [] },
    fill: READY_AS_IS,
    preview: [
      ["Ask", "Thanks for replying! What caught your eye?"],
      ["Hand to a person", "With what they said"],
    ],
    graph: () =>
      g(
        "ask",
        [
          ask(
            "ask",
            "Thanks for replying! What caught your eye?",
            { field: "story_interest", kind: "text" },
            { next: "hand" },
          ),
          [0, 0],
        ],
        [hand("hand", "Replied to a story"), [0, 1]],
      ),
  },
  story_mention: {
    group: "leads",
    name: "Story mention",
    what: "Thanks anyone who mentions you in their story.",
    why: "A thank-you for every mention, and a way to say more if they want it.",
    starts: "Someone mentions you in their story",
    trigger: { kind: "story_mention", keywords: [] },
    fill: READY_AS_IS,
    preview: [
      ["Send a message", "Thank you for the mention! It made our day."],
      ["Send a message", "Want to hear what’s new?  Yes, please / Not now"],
      ["Hand to a person", "If they tap Yes, please"],
    ],
    graph: () =>
      g(
        "thanks",
        [msg("thanks", "Thank you for the mention! It made our day.", { next: "more" }), [0, 0]],
        [
          msg("more", "Want to hear what’s new?", {
            replies: [
              ["Yes, please", "hand"],
              ["Not now", "bye"],
            ],
          }),
          [0, 1],
        ],
        [hand("hand", "Wants to hear what’s new"), [0, 2]],
        [msg("bye", "No problem. Thanks again!"), [1, 2]],
      ),
  },
  ad_greeting: {
    group: "leads",
    name: "Ad greeting",
    what: "Greets people from a click-to-message ad.",
    why: "They came from an ad: a hello in seconds, one question, and the ad they came from kept on the lead.",
    starts: "Someone taps Send message on your ad",
    trigger: { kind: "ad", keywords: [] },
    fill: READY_AS_IS,
    preview: [
      ["Send a message", "Hi! Thanks for tapping the ad."],
      ["Ask with buttons", "What would you like?  Prices / Book a call / A question"],
      ["Hand to a person", "With their answer"],
    ],
    graph: () =>
      g(
        "hi",
        [msg("hi", "Hi! Thanks for tapping the ad.", { next: "what" }), [0, 0]],
        [
          ask(
            "what",
            "What would you like?",
            { field: "interest", kind: "choice" },
            {
              choices: [
                ["Prices", "hand"],
                ["Book a call", "hand"],
                ["A question", "hand"],
              ],
            },
          ),
          [0, 1],
        ],
        [hand("hand", "Came from an ad"), [0, 2]],
      ),
  },
  welcome: {
    group: "answer",
    name: "Welcome",
    what: "A first hello, and what they’d like help with.",
    why: "Every new conversation gets an answer in seconds, even at night.",
    starts: "Someone writes to you for the first time",
    trigger: { kind: "welcome", keywords: [] },
    fill: READY_AS_IS,
    preview: [
      ["Send a message", "Hi! Thanks for writing."],
      ["Ask with buttons", "What can I help with?  Prices / Hours / Something else"],
      ["Hand to a person", "With their answer"],
    ],
    graph: () =>
      g(
        "hi",
        [msg("hi", "Hi! Thanks for writing.", { next: "what" }), [0, 0]],
        [
          ask(
            "what",
            "What can I help with?",
            { field: "interest", kind: "choice" },
            {
              choices: [
                ["Prices", "hand"],
                ["Hours", "hand"],
                ["Something else", "hand"],
              ],
            },
          ),
          [0, 1],
        ],
        [hand("hand", "New on Instagram"), [0, 2]],
      ),
  },
  price_question: {
    group: "sell",
    name: "Price question",
    what: "Prices on asking, then a call or a question.",
    why: "The question asked most in DMs, answered at once and turned towards a call.",
    starts: "A DM says “price”, “cost” or “fees”",
    trigger: { kind: "dm", keywords: ["price", "cost", "fees"] },
    fill: "Add your prices’ link and your booking link before it goes live.",
    preview: [
      ["Send a message", "Your prices, as a link"],
      ["Ask with buttons", "What next?  Book a call / Ask a question / Not now"],
      ["Book a call", "Your booking link"],
      ["Hand to a person", "Ask a question"],
    ],
    graph: () =>
      g(
        "prices",
        [
          msg("prices", "Thanks for asking! Tap below to see the prices.", {
            buttons: [["See the prices", ""]],
            next: "next",
          }),
          [0, 0],
        ],
        [
          msg("next", "What would you like next?", {
            replies: [
              ["Book a call", "call"],
              ["Ask a question", "hand"],
              ["Not now", "bye"],
            ],
          }),
          [0, 1],
        ],
        [book("call", "Pick a time that suits you."), [0, 2]],
        [hand("hand", "Has a question about prices"), [1, 2]],
        [msg("bye", "No problem. Write any time."), [2, 2]],
      ),
  },
  qualify_and_book: {
    group: "sell",
    name: "Qualify and book a call",
    what: "Three questions; a good fit gets your booking link.",
    why: "Asks what they want, when and how ready they are, so your team talks to the people who fit.",
    starts: "A DM says “call”, “book” or “consult”",
    trigger: { kind: "dm", keywords: ["call", "book", "consult"] },
    fill: "Write your choices and add your booking link before it goes live.",
    preview: [
      ["Ask with buttons", "What are you looking for?"],
      ["Ask with buttons", "When would you like to start?"],
      ["Ask with buttons", "How ready are you?"],
      ["Check", "Ready, and starting soon?"],
      ["Book a call", "Your booking link"],
      ["Hand to a person", "Everyone else"],
    ],
    graph: () =>
      g(
        "want",
        [
          ask(
            "want",
            "Happy to help! What are you looking for?",
            { field: "interest", kind: "choice" },
            {
              choices: [
                ["[[First choice]]", null],
                ["[[Second choice]]", null],
                ["Something else", null],
              ],
              next: "when",
            },
          ),
          [0, 0],
        ],
        [
          ask(
            "when",
            "When would you like to start?",
            { field: "start", kind: "choice" },
            {
              choices: [
                ["This week", null],
                ["This month", null],
                ["Later", null],
              ],
              next: "ready",
            },
          ),
          [0, 1],
        ],
        [
          ask(
            "ready",
            "And how ready are you?",
            { field: "readiness", kind: "choice" },
            {
              choices: [
                ["Ready to go", null],
                ["Still looking", null],
              ],
              next: "fit",
            },
          ),
          [0, 2],
        ],
        [
          {
            id: "fit",
            type: "check",
            match: "all",
            rules: [
              { on: "answer", key: "readiness", op: "is", value: "Ready to go" },
              { on: "answer", key: "start", op: "is_not", value: "Later" },
            ],
            yes: "call",
            no: "hand",
          },
          [0, 3],
        ],
        [book("call", "Great fit! Pick a time for a short call."), [0, 4]],
        [hand("hand", "Asked about a call"), [1, 4]],
      ),
  },
  discount_code: {
    group: "sell",
    name: "Discount code",
    what: "A code on asking, and one reminder later that day.",
    why: "A code for a word, then one nudge while Instagram still allows it (within 24 hours).",
    starts: "Someone comments “CODE”",
    trigger: { kind: "comment", keywords: ["CODE"] },
    fill: "Write your code and add your shop’s link before it goes live.",
    preview: [
      ["Private reply", "Here’s your code. Tap to see it."],
      ["Send a message", "Your code, and your shop as a link"],
      ["Update the lead", "Tagged “code”"],
      ["Wait", "20 hours"],
      ["Send a message", "Your code is still here"],
    ],
    graph: () =>
      g(
        "pr",
        [
          msg("pr", "Here’s your code. Tap below to see it.", { replies: [["Show my code", "code"]] }),
          [0, 0],
        ],
        [
          msg("code", "Your code: [[YOUR CODE]]. Use it at checkout.", {
            buttons: [["Shop now", ""]],
            next: "tag",
          }),
          [0, 1],
        ],
        [tag("tag", "code", "wait"), [0, 2]],
        [wait("wait", 20 * 60, "again"), [0, 3]],
        [
          msg("again", "Your code is still here whenever you’re ready.", { buttons: [["Shop now", ""]] }),
          [0, 4],
        ],
      ),
  },
  waitlist: {
    group: "sell",
    name: "Waitlist",
    what: "Takes an email for something not open yet.",
    why: "For a launch or a new batch: everyone who asks is kept, with an email to reach them on the day it opens.",
    starts: "A DM says “waitlist” or “notify me”",
    trigger: { kind: "dm", keywords: ["waitlist", "notify me"] },
    fill: READY_AS_IS,
    preview: [
      ["Send a message", "It isn’t open yet, but you can be first to know."],
      ["Ask", "Their email, saved on the lead"],
      ["Update the lead", "Tagged “waitlist”"],
      ["Send a message", "You’re on the list!"],
    ],
    graph: () =>
      g(
        "hi",
        [msg("hi", "It isn’t open yet, but you can be first to know.", { next: "email" }), [0, 0]],
        [
          ask(
            "email",
            "What’s your email? It keeps your place on the list.",
            { field: "email", kind: "email" },
            { next: "tag" },
          ),
          [0, 1],
        ],
        [tag("tag", "waitlist", "done"), [0, 2]],
        [msg("done", "You’re on the list!"), [0, 3]],
      ),
  },
  faq_menu: {
    group: "answer",
    name: "Common questions",
    what: "Hours, where you are, prices, or a person.",
    why: "Answers the same few questions every time, and comes back to the menu after each.",
    starts: "A DM says “help”, “info” or “hours”",
    trigger: { kind: "dm", keywords: ["help", "info", "hours"] },
    fill: "Write your answers before it goes live.",
    preview: [
      ["Ask with buttons", "What would you like to know?  Hours / Where / Prices / A person"],
      ["Send a message", "Each answer, as you write it"],
      ["Back to the menu", "After each answer"],
      ["Hand to a person", "A person"],
    ],
    graph: () =>
      g(
        "menu",
        [
          ask(
            "menu",
            "What would you like to know?",
            { field: "question", kind: "choice" },
            {
              choices: [
                ["Hours", "hours"],
                ["Where", "where"],
                ["Prices", "prices"],
                ["A person", "hand"],
              ],
            },
          ),
          [1, 0],
        ],
        [msg("hours", "[[Your opening hours]]", { next: "menu" }), [0, 1]],
        [msg("where", "[[Where to find you]]", { next: "menu" }), [1, 1]],
        [msg("prices", "[[Your prices]]", { next: "menu" }), [2, 1]],
        [hand("hand", "Asked for a person"), [3, 1]],
      ),
  },
  appointment: {
    group: "answer",
    name: "Book an appointment",
    what: "Picks a service, then your booking link.",
    why: "For salons, clinics and studios: the service first, then the booking page.",
    starts: "A DM says “appointment” or “slot”",
    trigger: { kind: "dm", keywords: ["appointment", "slot"] },
    fill: "Write your services and add your booking link before it goes live.",
    preview: [
      ["Ask with buttons", "Which service?"],
      ["Book a call", "Your booking link"],
      ["Hand to a person", "If none fits"],
    ],
    graph: () =>
      g(
        "which",
        [
          ask(
            "which",
            "Which service would you like?",
            { field: "service", kind: "choice" },
            {
              choices: [
                ["[[Service one]]", "book"],
                ["[[Service two]]", "book"],
                ["Something else", "hand"],
              ],
            },
          ),
          [0, 0],
        ],
        [book("book", "Pick a time that suits you."), [0, 1]],
        [hand("hand", "Wants a service not on the list"), [1, 1]],
      ),
  },
  feedback: {
    group: "answer",
    name: "Feedback",
    what: "A rating; happy people get your review link.",
    why: "Four or five get your review link; anything lower goes straight to a person.",
    starts: "A DM says “feedback”",
    trigger: { kind: "dm", keywords: ["feedback"] },
    fill: "Add your review link before it goes live.",
    preview: [
      ["Ask with buttons", "How was it?  5 to 1"],
      ["Check", "4 or 5?"],
      ["Send a message", "Your review link"],
      ["Hand to a person", "1 to 3, with their rating"],
    ],
    graph: () =>
      g(
        "rate",
        [
          ask(
            "rate",
            "How was it? Tap a number, 5 is best.",
            { field: "rating", kind: "choice" },
            {
              choices: [
                ["5", null],
                ["4", null],
                ["3", null],
                ["2", null],
                ["1", null],
              ],
              next: "happy",
            },
          ),
          [0, 0],
        ],
        [
          {
            id: "happy",
            type: "check",
            match: "any",
            rules: [
              { on: "answer", key: "rating", op: "is", value: "5" },
              { on: "answer", key: "rating", op: "is", value: "4" },
            ],
            yes: "review",
            no: "hand",
          },
          [0, 1],
        ],
        [
          msg("review", "Thank you! Would you leave a review? It helps a lot.", {
            buttons: [["Leave a review", ""]],
          }),
          [0, 2],
        ],
        [hand("hand", "Gave a low rating"), [1, 2]],
      ),
  },
  event_signup: {
    group: "events",
    name: "Event sign-up",
    what: "Signs them up and sends the event’s link and time.",
    why: "For a webinar, a class or a live: the link and the time, and an email so you can remind them yourself.",
    starts: "Someone comments “JOIN”",
    trigger: { kind: "comment", keywords: ["JOIN"] },
    fill: "Write the event’s name and time, and add its link, before it goes live.",
    preview: [
      ["Private reply", "You’re in! Tap below for the details."],
      ["Ask", "Their email, saved on the lead"],
      ["Send a message", "The event’s link and time"],
      ["Update the lead", "Tagged “event”"],
      ["Tell your team", "A new sign-up"],
    ],
    graph: () =>
      g(
        "pr",
        [
          msg("pr", "You’re in! Tap below for the details.", { replies: [["Send the details", "email"]] }),
          [0, 0],
        ],
        [
          ask(
            "email",
            "What’s your email, in case the details change?",
            { field: "email", kind: "email" },
            { next: "details" },
          ),
          [0, 1],
        ],
        [
          msg("details", "[[The event]] is on [[the day and time]]. Here’s the link to join.", {
            buttons: [["Join the event", ""]],
            next: "tag",
          }),
          [0, 2],
        ],
        [tag("tag", "event", "tell"), [0, 3]],
        [tell("tell", "A new sign-up for the event."), [0, 4]],
      ),
  },
  giveaway: {
    group: "events",
    name: "Giveaway entry",
    what: "Confirms each entry by DM, with the rules.",
    why: "Every entry hears back and gets the rules. Instagram doesn’t let any app check who follows you, so this one doesn’t try.",
    starts: "Someone comments “WIN”",
    trigger: { kind: "comment", keywords: ["WIN"] },
    fill: "Add the rules’ link before it goes live.",
    preview: [
      ["Private reply", "You’re entered! Good luck."],
      ["Send a message", "The rules, as a link"],
      ["Update the lead", "Tagged “giveaway”"],
    ],
    graph: () =>
      g(
        "pr",
        [msg("pr", "You’re entered! Good luck.", { replies: [["See the rules", "rules"]] }), [0, 0]],
        [msg("rules", "Here are the rules.", { buttons: [["Read the rules", ""]], next: "tag" }), [0, 1]],
        [tag("tag", "giveaway"), [0, 2]],
      ),
  },
} satisfies Record<string, ReadyDef>;

export type ReadyKey = keyof typeof READY_FLOWS;
export type ReadyFlow = ReadyDef & { key: ReadyKey };
export const READY_KEYS = Object.keys(READY_FLOWS) as ReadyKey[];
export const readyFlow = (key: ReadyKey): ReadyFlow => ({ key, ...(READY_FLOWS[key] as ReadyDef) });

/** The tags a ready-made flow names ("#label"), for LUME to find or make when the flow is made. */
export function readyTags(graph: FlowGraph): string[] {
  const out = new Set<string>();
  for (const n of graph.nodes)
    if (n.type === "update")
      for (const a of n.actions) if (a.kind === "tag" && a.tagId.startsWith("#")) out.add(a.tagId.slice(1));
  return [...out];
}

/** The graph with each "#label" tag set to the business's tag (an empty id where there's none, for it to choose). */
export function withTags(graph: FlowGraph, ids: Record<string, string>): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.type === "update"
        ? {
            ...n,
            actions: n.actions.map((a) =>
              a.kind === "tag" && a.tagId.startsWith("#") ? { ...a, tagId: ids[a.tagId.slice(1)] ?? "" } : a,
            ),
          }
        : n,
    ),
  };
}
