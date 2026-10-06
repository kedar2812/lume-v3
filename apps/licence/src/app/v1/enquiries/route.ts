import { context } from "@/server/context";
import { handleEnquiry } from "@/server/enquiries";

export const dynamic = "force-dynamic";

/** The website's enquiries (website spec §7). */
export function POST(req: Request): Promise<Response> {
  return handleEnquiry(req, context());
}
