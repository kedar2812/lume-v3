import { handleActivate } from "@/server/activate";
import { context } from "@/server/context";

export const dynamic = "force-dynamic";

/** A product key entered on an instance (spec 2026-10-15 §2.1). */
export function POST(req: Request): Promise<Response> {
  return handleActivate(req, context());
}
