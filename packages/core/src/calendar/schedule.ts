import { z } from "zod";
import { callTimeLabel } from "../ai/calls";

/**
 * Schedule a meeting (owner, 2026-11-13): a person books a call with a lead from its card or the Calendar, on their own
 * Google Calendar with a Meet link, and may send the link on WhatsApp.
 */
export const SCHEDULE_MINUTES = [15, 30, 45, 60, 90] as const;

export const scheduleMeetingSchema = z
  .object({
    leadId: z.uuid({ error: "Choose a lead." }),
    title: z
      .string({ error: "Give the meeting a title." })
      .trim()
      .min(1, "Give the meeting a title.")
      .max(200, "A title is at most 200 characters."),
    startsAt: z.iso.datetime({ error: "Choose a day and a time." }),
    minutes: z
      .number({ error: "A meeting is 15, 30, 45, 60 or 90 minutes." })
      .refine(
        (m) => (SCHEDULE_MINUTES as readonly number[]).includes(m),
        "A meeting is 15, 30, 45, 60 or 90 minutes.",
      ),
    notes: z.string().trim().max(1000, "Notes are at most 1,000 characters.").default(""),
  })
  .strict();
export type ScheduleMeeting = z.infer<typeof scheduleMeetingSchema>;

/** What goes to the lead on WhatsApp, ready to edit: their first name, the time on the business's clock, the link. */
export function meetingMessage(o: { name: string | null; at: Date; tz: string; link: string }): string {
  const first = (o.name ?? "").trim().split(/\s+/)[0];
  return `Hi${first ? ` ${first}` : ""}, here's the Google Meet link for our call on ${callTimeLabel(o.at, o.tz)}: ${o.link}`;
}
