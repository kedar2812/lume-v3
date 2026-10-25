import type { AppDeps } from "../../app";
import { WHATSAPP_PHOTO_MAX } from "../whatsapp/sniff";

/** A copy waits at most this long: the send goes on without one (as a document) rather than hold the queue. */
const PHOTO_TIMEOUT_MS = 30_000;

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * A photo over WhatsApp's 5 MB, as a copy that fits (owner, 2026-10-25: photos up to 20 MB in Media): a JPEG the render
 * service makes, its long edge at most 2560 px. Nothing when there's no render service, it fails, or what it answers
 * isn't a JPEG that fits; the caller then sends the photo whole, as a document.
 */
export async function photoForWhatsApp(d: AppDeps, bytes: Buffer, mime: string): Promise<Buffer | null> {
  if (!d.render) return null;
  try {
    const r = await fetch(`${d.render.url}/v1/photo`, {
      method: "POST",
      body: bytes,
      headers: { "content-type": mime },
      signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const copy = Buffer.from(await r.arrayBuffer());
    return isJpeg(copy) && copy.length <= WHATSAPP_PHOTO_MAX ? copy : null;
  } catch {
    return null;
  }
}
