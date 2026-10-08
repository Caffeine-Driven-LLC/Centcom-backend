/**
 * A write button (B088): rendered only for roles that may write (callers check `canWrite`), it
 * runs its call once, never retrying, and shows the outcome. A destructive action first asks for
 * its target id to be typed (ConfirmDialog).
 */
import { useState, type ReactNode } from 'react';
import { ConfirmDialog } from './dialogs.js';
import { ErrorNotice } from './common.js';

export function WriteAction<T>({
  label,
  confirmTarget,
  run,
  done,
}: {
  label: string;
  /** For a destructive action: the id to type before it runs. */
  confirmTarget?: string;
  run(): Promise<T>;
  /** What to show once it worked. */
  done(result: T): ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ result: T } | { error: unknown } | null>(null);
  const go = async () => {
    setConfirming(false);
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome({ result: await run() });
    } catch (error) {
      setOutcome({ error });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="write-action">
      <button
        type="button"
        className={confirmTarget === undefined ? undefined : 'danger'}
        disabled={busy}
        onClick={() => (confirmTarget === undefined ? void go() : setConfirming(true))}
      >
        {label}
      </button>
      {outcome === null ? null : 'error' in outcome ? (
        <ErrorNotice error={outcome.error} />
      ) : (
        <div role="status" className="notice">
          {done(outcome.result)}
        </div>
      )}
      {confirming && confirmTarget !== undefined ? (
        <ConfirmDialog
          action={label}
          target={confirmTarget}
          onConfirm={() => void go()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
