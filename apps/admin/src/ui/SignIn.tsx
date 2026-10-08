/**
 * Sign-in (B088): the staff member pastes a staff access token (one with scope `admin`, from the
 * staff token flow). It is held in memory only. The console then asks the admin API for the
 * staff member's own record, which says their role; that first call needs a reason too.
 */
import { useEffect, useRef, useState, type SubmitEvent } from 'react';

export function SignIn({
  notice,
  onSignIn,
}: {
  /** Why the staff member is here (signed out after idling, refused, ...). */
  notice: string | null;
  /** Signs in; resolves to a message when it did not work. */
  onSignIn(token: string): Promise<string | null>;
}) {
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const message = await onSignIn(token.trim());
    setBusy(false);
    if (message !== null) setProblem(message);
    // The field is cleared either way: the token lives in the console's memory, not in a form.
    setToken('');
  };
  return (
    <main id="main" className="sign-in">
      <h1>Centcom admin</h1>
      {notice === null ? null : (
        <p role="alert" className="notice">
          {notice}
        </p>
      )}
      <form onSubmit={(e) => void submit(e)}>
        <label htmlFor="staff-token">Staff access token</label>
        <textarea
          id="staff-token"
          ref={field}
          value={token}
          rows={4}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="staff-token-help staff-token-problem"
          onChange={(e) => setToken(e.target.value)}
        />
        <p id="staff-token-help" className="muted">
          A token with the admin scope from the staff token flow. It is kept in this tab&apos;s
          memory only and dropped after 15 minutes without activity.
        </p>
        <p id="staff-token-problem" className="field-error" role="status">
          {problem}
        </p>
        <button type="submit" disabled={busy || token.trim() === ''}>
          Sign in
        </button>
      </form>
    </main>
  );
}
