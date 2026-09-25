/**
 * Report §11.4: how a message leaves LUME. v1 has one channel, click-to-send (a wa.me link the person
 * opens themselves); the Cloud API can implement this interface later without touching callers.
 */
export type PreparedMessage = { url: string };
export interface MessageChannel {
  readonly name: string;
  prepare(to: { e164: string }, text: string): PreparedMessage;
}

export const clickToSend: MessageChannel = {
  name: "click_to_send",
  prepare(to, text) {
    const digits = to.e164.replace(/\D/g, "");
    return { url: `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}` };
  },
};
