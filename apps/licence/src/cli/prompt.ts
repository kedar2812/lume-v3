import type { Readable, Writable } from "node:stream";

type Tty = Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };

/**
 * Asks a question and reads the answer without echoing it (a password): the terminal is put in raw mode and
 * given back as it was. Backspace edits; Enter answers; Ctrl-C cancels.
 */
export function askHidden(
  question: string,
  io: { input: Tty; output: Writable } = { input: process.stdin, output: process.stdout },
): Promise<string> {
  const { input, output } = io;
  output.write(question);
  const raw = Boolean(input.isTTY && input.setRawMode);
  if (raw) input.setRawMode!(true);
  return new Promise((resolve, reject) => {
    let typed = "";
    const done = (fn: () => void) => {
      input.off("data", onData);
      if (raw) input.setRawMode!(false);
      input.pause();
      output.write("\n");
      fn();
    };
    const onData = (b: Buffer | string) => {
      for (const ch of b.toString()) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(typed.trim()));
        if (ch === "\u0003") return done(() => reject(new Error("Cancelled.")));
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    input.on("data", onData);
    input.resume();
  });
}
