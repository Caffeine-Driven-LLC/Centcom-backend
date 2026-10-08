/**
 * The console's two dialogs (B088):
 *
 * - `ReasonDialog`: why the staff member is looking (10-500 characters) and an optional ticket.
 *   Every admin call needs one; until it is given (or when it is cancelled), nothing is sent.
 * - `ConfirmDialog`: a destructive action (revoke tokens, disable a user, end a session) goes ahead
 *   only once the exact target id is typed; any other text keeps the button disabled.
 *
 * Both are modal (`role="dialog"`, labelled), take focus when they open and close on Escape.
 */
import { useEffect, useId, useRef, useState, type SubmitEvent, type KeyboardEvent } from 'react';
import { reasonProblem, REASON_MAX, ticketProblem, toReason, type Reason } from '../api/reason.js';

/** Asks for a reason and ticket. */
export function ReasonDialog({
  initial,
  onDone,
}: {
  initial: Reason | null;
  /** The reason given, or null when cancelled. */
  onDone(reason: Reason | null): void;
}) {
  const titleId = useId();
  const [reason, setReason] = useState(initial?.reason ?? '');
  const [ticket, setTicket] = useState(initial?.ticket ?? '');
  const [touched, setTouched] = useState(false);
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => first.current?.focus(), []);
  const reasonError = reasonProblem(reason);
  const ticketError = ticketProblem(ticket);
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    setTouched(true);
    const given = toReason(reason, ticket);
    if (given !== null) onDone(given);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDone(null);
    }
  };
  return (
    <div className="backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>Why are you looking?</h2>
        <p>Every admin call is audited with your reason. Nothing is sent without one.</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor={`${titleId}-reason`}>Reason (10 to {REASON_MAX} characters)</label>
          <textarea
            id={`${titleId}-reason`}
            ref={first}
            value={reason}
            maxLength={REASON_MAX}
            rows={3}
            aria-invalid={touched && reasonError !== null}
            aria-describedby={`${titleId}-reason-error`}
            onChange={(e) => setReason(e.target.value)}
          />
          <p id={`${titleId}-reason-error`} className="field-error">
            {touched ? reasonError : null}
          </p>
          <label htmlFor={`${titleId}-ticket`}>Ticket (optional)</label>
          <input
            id={`${titleId}-ticket`}
            value={ticket}
            maxLength={64}
            autoComplete="off"
            aria-invalid={touched && ticketError !== null}
            aria-describedby={`${titleId}-ticket-error`}
            onChange={(e) => setTicket(e.target.value)}
          />
          <p id={`${titleId}-ticket-error`} className="field-error">
            {touched ? ticketError : null}
          </p>
          <div className="actions">
            <button type="submit">Use this reason</button>
            <button type="button" onClick={() => onDone(null)}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Confirms a destructive action by typing its target id. */
export function ConfirmDialog({
  action,
  target,
  onConfirm,
  onCancel,
}: {
  /** What will happen, such as "Disable sign-in". */
  action: string;
  /** The id to type. */
  target: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const titleId = useId();
  const [typed, setTyped] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const matches = typed === target;
  return (
    <div className="backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 id={titleId}>{action}</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (matches) onConfirm();
          }}
        >
          <label htmlFor={`${titleId}-target`}>
            Type <code>{target}</code> to confirm
          </label>
          <input
            id={`${titleId}-target`}
            ref={input}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
          />
          <div className="actions">
            <button type="submit" className="danger" disabled={!matches}>
              {action}
            </button>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
