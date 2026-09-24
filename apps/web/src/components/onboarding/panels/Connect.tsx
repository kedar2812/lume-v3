import { ConnectCards } from "../ConnectCards";
import { PanelHead } from "./Head";

export function ConnectPanel({
  kicker,
  calendar,
  sheets,
}: {
  kicker: string;
  calendar: boolean;
  sheets: boolean;
}) {
  return (
    <>
      <PanelHead
        kicker={kicker}
        title="Connect your tools"
        lead="Optional. You can connect these any time from Settings."
      />
      <ConnectCards calendar={calendar} sheets={sheets} />
    </>
  );
}
