import {
  ArrowUpRight,
  AtSign,
  BellRing,
  CalendarCheck,
  Check,
  ChevronLeft,
  CircleDot,
  CircleStop,
  Clock,
  FileDown,
  Forward,
  Gift,
  GitBranch,
  Hand,
  History,
  Handshake,
  Hourglass,
  Inbox,
  Info,
  Link,
  Lock,
  Megaphone,
  MessageCircleMore,
  MessageCircleQuestionMark,
  MessageSquare,
  MessageSquarePlus,
  Percent,
  Play,
  Plus,
  Reply,
  Search,
  ShieldCheck,
  Split,
  Star,
  Tag,
  Ticket,
  Timer,
  TriangleAlert,
  UserPen,
  X,
  type LucideIcon,
} from "lucide-react";

/**
 * LUME's icons (owner 2026-11-25; docs/design/icons.md): Lucide's line icons as drawn, on a 24 grid with a stroke of 2,
 * round ends, in the text's colour. Each says what the thing does, and one meaning has one icon everywhere: a screen
 * takes its icon from here, never draws its own. Only LUME AI's Loop, Live sheets' mark and other companies' own logos
 * are drawn elsewhere.
 */
export type { LucideIcon as Icon };

/** What starts an Instagram flow. */
export const TRIGGER_ICONS = {
  // Not MessageCircle: that is Who replied, in the sidebar (one meaning, one icon).
  comment: MessageCircleMore,
  dm: MessageSquare,
  story_reply: CircleDot,
  story_mention: AtSign,
  ad: Megaphone,
  welcome: MessageSquarePlus,
} satisfies Record<string, LucideIcon>;

/** A flow's steps, by kind. Booking is the same calendar wherever it appears. */
export const STEP_ICONS = {
  message: MessageSquare,
  ask: MessageCircleQuestionMark,
  check: GitBranch,
  split: Split,
  wait: Timer,
  update: UserPen,
  notify: BellRing,
  goto: Forward,
  handoff: Handshake,
  book: CalendarCheck,
  end: CircleStop,
} satisfies Record<string, LucideIcon>;

/** The ready-made flows (plan 2026-11-23-flow-builder, Task D7), each by what it does. */
export const FLOW_TEMPLATE_ICONS = {
  comment_link: Link,
  comment_freebie: FileDown,
  story_reply: Reply,
  story_mention: AtSign,
  ad_greeting: Megaphone,
  welcome: Hand,
  price_question: Tag,
  qualify_and_book: CalendarCheck,
  discount_code: Percent,
  waitlist: Hourglass,
  faq_menu: MessageCircleQuestionMark,
  appointment: Clock,
  feedback: Star,
  event_signup: Ticket,
  giveaway: Gift,
} satisfies Record<string, LucideIcon>;

/** Ideas that appear on many screens. The sidebar's own icons are in components/shell/icons.tsx. */
export const UI_ICONS = {
  /** Close a panel, a sheet or a dialog. */
  close: X,
  /** Back to where this came from. */
  back: ChevronLeft,
  /** Earlier versions. */
  versions: History,
  /** Try it, play it. */
  play: Play,
  /** Done, chosen. */
  done: Check,
  /** Good to know (never a warning). */
  info: Info,
  /** Messages of any kind arriving: DMs, comments, replies (Team Chat keeps MessagesSquare). */
  arriving: Inbox,
  /** Kept private, on the business's own server. */
  private: Lock,
  /** Inside a platform's rules (Instagram's, Meta's). */
  rules: ShieldCheck,
  /** Something to watch out for. */
  warning: TriangleAlert,
  /** Leaves LUME for another site. */
  external: ArrowUpRight,
  /** Make a new one. */
  add: Plus,
  /** Search. */
  search: Search,
} satisfies Record<string, LucideIcon>;

/** The size icons are drawn at beside text of each size; the stroke stays Lucide's 2. */
export const ICON_SIZE = { sm: 14, md: 16, lg: 18, tile: 18 } as const;
