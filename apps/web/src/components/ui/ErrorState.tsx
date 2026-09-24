import { Button } from "./Button";
import s from "./ErrorState.module.css";

/** One way to show a failure: what happened, in plain words, and a way forward. */
export function ErrorState({
  title = "That didn’t work",
  message,
  action,
}: {
  title?: string;
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className={s.wrap} role="alert">
      <h2 className={s.title}>{title}</h2>
      <p className={s.message}>{message}</p>
      {action ? (
        <Button variant="secondary" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
