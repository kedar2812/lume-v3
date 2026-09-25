export type BoardKeysState = { picked: null | { leadId: string; from: number; to: number } };
export type BoardKeysEvent =
  | { type: "pick"; leadId: string; column: number }
  | { type: "left" }
  | { type: "right"; columns: number }
  | { type: "drop" }
  | { type: "cancel" };

/** The board without a mouse (spec §6): Space picks up, arrows choose the stage, Enter drops, Escape cancels. */
export function boardKeys(state: BoardKeysState, e: BoardKeysEvent): BoardKeysState {
  if (e.type === "pick") return { picked: { leadId: e.leadId, from: e.column, to: e.column } };
  if (!state.picked) return state;
  switch (e.type) {
    case "left":
      return { picked: { ...state.picked, to: Math.max(0, state.picked.to - 1) } };
    case "right":
      return { picked: { ...state.picked, to: Math.min(e.columns - 1, state.picked.to + 1) } };
    case "drop":
    case "cancel":
      return { picked: null };
  }
}
