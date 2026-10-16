import { context } from "@/server/context";
import { handleFeedback } from "@/server/feedback";

export const dynamic = "force-dynamic";

/** A report from a client's LUME (spec 2026-10-16 §2.1). */
export function POST(req: Request): Promise<Response> {
  return handleFeedback(req, context());
}
