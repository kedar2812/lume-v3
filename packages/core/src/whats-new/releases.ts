import type { PermissionKey } from "../rbac/catalog";

/**
 * What's new in LUME (spec 2026-11-02): each release's stories ship with the code, so a deploy carries
 * its own announcement. Newest first. A story names where it lives (a route and the element Show me
 * points at), the permission that place needs and the feature it needs switched on, so a person is
 * only told about what they can open here.
 */
export type StoryId = "calls" | "chats" | "templates";

export type Story = {
  id: StoryId;
  kicker: "lume-ai" | "whatsapp" | "lume";
  /** The headline in two short lines. */
  head: [string, string];
  /** One sentence. */
  sub: string;
  /** How long the story plays by itself. */
  ms: number;
  /** `target` matches a `data-whatsnew="…"` or `data-tour="…"` attribute on that route. */
  place: { route: string; target: string };
  permission: PermissionKey;
  needs: "ai" | "whatsapp" | null;
  /** Show me's tip beside the target. */
  tip: { title: string; body: string };
};

export type Release = {
  version: string;
  /** The version the opening rolls from. */
  from: string;
  /** YYYY-MM-DD: the "New" pills last a week from it; people who join on or after it skip the window. */
  date: string;
  stories: Story[];
  /** Smaller changes, one line each, no Show me. */
  alsoNew: string[];
};

export const RELEASES: readonly Release[] = [
  {
    version: "1.2.0",
    from: "1.1.0",
    date: "2026-11-05",
    stories: [
      {
        id: "calls",
        kicker: "lume-ai",
        head: ["LUME AI books", "your calls."],
        sub: "Give it the times you take calls. When a lead asks for one and you're free, it says yes, books it and sends the Google Meet link if you let it.",
        ms: 8500,
        place: { route: "/settings/ai", target: "calls" },
        permission: "settings.manage",
        needs: "ai",
        tip: {
          title: "Calls LUME AI may book",
          body: "Set the days and times you take calls. LUME AI only says yes inside them.",
        },
      },
      {
        id: "chats",
        kicker: "whatsapp",
        head: ["Your chats,", "live in LUME."],
        sub: "A lead's message shows the moment it arrives, with a notice on whatever screen you're on, and their chat opens in its own window.",
        ms: 8000,
        place: { route: "/replies", target: "nav-replies" },
        permission: "leads.view",
        needs: "whatsapp",
        tip: {
          title: "Every chat, as it happens",
          body: "New messages land here the moment they arrive. Open one to answer in its own window.",
        },
      },
      {
        id: "templates",
        kicker: "lume-ai",
        head: ["Templates,", "written for you."],
        sub: "Say what a template is for and LUME AI writes a few to choose from. In a chat, one tap puts yours in the reply box.",
        ms: 8000,
        place: { route: "/templates", target: "write-with-ai" },
        permission: "templates.manage",
        needs: "ai",
        tip: {
          title: "Write with LUME AI",
          body: "Say what the template is for, then pick the draft you like and edit it as you wish.",
        },
      },
    ],
    alsoNew: [
      "The two-step code is ready to type, no click first",
      "Lift do not contact from LUME AI's chat",
      "Delete your own account, from My account",
      "Profile photos save from every browser",
    ],
  },
];
