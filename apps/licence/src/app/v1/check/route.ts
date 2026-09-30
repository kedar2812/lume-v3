import { handleCheck } from "@/server/check";
import { context } from "@/server/context";

export const dynamic = "force-dynamic";

/** Every LUME instance's licence check (spec §4.3). */
export function POST(req: Request): Promise<Response> {
  return handleCheck(req, context());
}
