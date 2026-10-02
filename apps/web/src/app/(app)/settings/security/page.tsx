import { redirect } from "next/navigation";
import { requirePermission } from "@/server/session";

/** Security opens on its Rules until its Overview is built (6A Task 8). */
export default async function Page() {
  await requirePermission("security.manage");
  redirect("/settings/security/rules");
}
