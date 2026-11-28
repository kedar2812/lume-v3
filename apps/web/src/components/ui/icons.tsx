import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  AtSign,
  Ban,
  BellRing,
  CalendarCheck,
  CalendarDays,
  CalendarPlus,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleDot,
  CircleStop,
  Clock,
  Columns3,
  Copy,
  Download,
  Ellipsis,
  EyeOff,
  FileDown,
  Forward,
  Gift,
  GitBranch,
  Globe,
  GripVertical,
  Hand,
  Handshake,
  History,
  Hourglass,
  Inbox,
  Info,
  Link,
  ListFilter,
  Lock,
  Mail,
  Maximize2,
  Megaphone,
  MessageCircleMore,
  MessageCircleQuestionMark,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  Pause,
  Pencil,
  Percent,
  Phone,
  PhoneCall,
  PhoneMissed,
  Play,
  Plus,
  Reply,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Split,
  Star,
  Tag,
  Ticket,
  Timer,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  UserMinus,
  UserPen,
  UserPlus,
  Video,
  Voicemail,
  WifiLow,
  WifiOff,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
  CalendarClock,
  CalendarRange,
  ClipboardCheck,
  List,
  UserRound,
  UserX,
  UserRoundPlus,
  EyeClosed,
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
  /** This device's connection is down. */
  offline: WifiOff,
  /** This device's connection is slow. */
  slowNetwork: WifiLow,
  /** Opens a list to choose from. */
  menu: ChevronDown,
  /** The one before, and the one after (a lead in the drawer). */
  previous: ChevronUp,
  next: ChevronDown,
  /** Move it up or down the order. */
  moveUp: ArrowUp,
  moveDown: ArrowDown,
  /** Take it off (a filter, a file waiting to go). Closing a panel is `close`. */
  remove: X,
  /** Delete for good. */
  delete: Trash2,
  /** Change it. */
  edit: Pencil,
  /** More actions. */
  more: Ellipsis,
  /** Put back what was just done. */
  undo: Undo2,
  /** What happened lately (bulk changes). */
  recent: History,
  /** A call, and a phone number. */
  call: Phone,
  /** An email address. */
  email: Mail,
  /** A call's outcome: talked, no answer, left a message. */
  talked: PhoneCall,
  noAnswer: PhoneMissed,
  leftMessage: Voicemail,
  /** Attach a file. */
  attach: Paperclip,
  /** Send it. */
  send: SendHorizontal,
  /** Templates (as the sidebar's). */
  templates: Mail,
  /** Sent, and delivered (a message's ticks). */
  sent: Check,
  delivered: CheckCheck,
  /** Hidden from you (a contact you may not see in full). */
  masked: EyeOff,
  /** Later: a limit that comes back at a time. */
  later: Clock,
  /** Do not contact. */
  doNotContact: Ban,
  /** A stage of the pipeline (as the sidebar's Pipeline). */
  stage: Columns3,
  /** Give it to someone. */
  assign: UserPlus,
  /** A tag. */
  tag: Tag,
  /** Which columns show. */
  columns: SlidersHorizontal,
  /** It didn't work. */
  failed: CircleAlert,
  /** Stopped before it finished. */
  stopped: CircleStop,
  /** Download it (an export). */
  download: Download,
  /** Bring a file in. */
  upload: Upload,
  /** The period before. */
  before: ChevronLeft,
  /** The period after. */
  after: ChevronRight,
  /** Opens it (a row with more inside). */
  open: ChevronRight,
  /** Drag to reorder. */
  drag: GripVertical,
  /** Put away (archived, not deleted). */
  archive: Archive,
  /** A photo. */
  photo: Camera,
  /** Pause. */
  pause: Pause,
  /** Take someone out of LUME (offboard). */
  offboard: UserMinus,
  /** Narrow what shows. */
  filter: ListFilter,
  /** The web (a website, web visits). */
  web: Globe,
  /** A date, a calendar (as the sidebar's Calendar). */
  calendar: CalendarDays,
  /** Put something on the calendar. */
  schedule: CalendarPlus,
  /** A video call. */
  video: Video,
  /** The Calendar's views: the agenda (a list of days), the week (its days side by side). */
  agenda: List,
  week: CalendarRange,
  /** Log how a call went (its outcome). */
  outcome: ClipboardCheck,
  /** A call the lead didn't join. */
  noShow: UserX,
  /** A call moved to another time. */
  rescheduled: CalendarClock,
  /** A lead (open its card). */
  lead: UserRound,
  /** Make someone a lead (assigning keeps UserPlus). */
  addLead: UserRoundPlus,
  /** Read, never kept (personal events LUME looks through and lets go). */
  notKept: EyeClosed,
  /** Settings (as the sidebar's). */
  settings: Settings,
  /** Zoom in. */
  zoomIn: ZoomIn,
  /** Zoom out. */
  zoomOut: ZoomOut,
  /** Open it full screen. */
  fullScreen: Maximize2,
  /** A link (as the ready-made flow's). */
  link: Link,
  /** Copy it. */
  copy: Copy,
} satisfies Record<string, LucideIcon>;

/** The size icons are drawn at beside text of each size; the stroke stays Lucide's 2. */
export const ICON_SIZE = { sm: 14, md: 16, lg: 18, tile: 18 } as const;
