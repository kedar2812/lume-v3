import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { askHidden } from "./prompt";

describe("admin-create's password prompt", () => {
  it("never echoes what's typed, and gives the terminal back as it was", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const output = new PassThrough();
    let shown = "";
    output.on("data", (b: Buffer) => (shown += b.toString()));
    const answer = askHidden("Password: ", { input, output });
    input.write("a long and lovely");
    input.write(" passphrase\x7f\x7fse\r");
    expect(await answer).toBe("a long and lovely passphrase");
    expect(shown).toContain("Password: ");
    expect(shown).not.toContain("lovely");
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it("Ctrl-C stops, and the terminal is given back", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const answer = askHidden("Password: ", { input, output: new PassThrough() });
    input.write("abc\x03");
    await expect(answer).rejects.toThrow(/cancelled/i);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });
});
