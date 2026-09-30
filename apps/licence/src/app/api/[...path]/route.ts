import { handleApi } from "@/server/api";
import { context } from "@/server/context";

export const dynamic = "force-dynamic";

/** The admin API (spec §4.4): one handler, so sign-in, sessions and CSRF guard every route the same way. */
const handle = (req: Request): Promise<Response> => handleApi(req, context());
export { handle as DELETE, handle as GET, handle as PATCH, handle as POST };
