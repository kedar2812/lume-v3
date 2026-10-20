import { context } from "@/server/context";
import { handleTopUp } from "@/server/topup";

export const dynamic = "force-dynamic";

/** A client's LUME asks for a LUME AI top-up (Autopilot spec 2026-10-19 §4). */
export function POST(req: Request): Promise<Response> {
  return handleTopUp(req, context());
}
