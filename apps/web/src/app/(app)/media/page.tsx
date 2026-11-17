import { can } from "@lume/core/shared";
import { MediaScreen } from "@/components/media/MediaScreen";
import type { LibraryFile } from "@/lib/files/client";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Media · LUME" };

/** Media (plan 2026-10-20-media-tab): the business's files, for everyone who may use templates. */
export default async function Page() {
  const session = await requirePermission("templates.use");
  const list = await apiGet<{ files: LibraryFile[] }>("/api/v1/files");
  // Never an empty library in place of one that couldn't be read (bug hunt 2026-11-17).
  if (list.status !== 200 || !list.data)
    return <p role="alert">LUME couldn&apos;t load your files just now. Reload the page to try again.</p>;
  return (
    <MediaScreen
      initial={list.data.files}
      canManage={can(session.actor, "templates.manage")}
      guideSeen={session.preferences.hints?.mediaGuide === true}
    />
  );
}
