/**
 * `/`: look up a user, workspace or session by id, or a user by e-mail address. The search stays
 * in the page: an address never goes into the console's URL.
 */
import type { AdminUserLookup } from '@centcom/api';
import { useState, type SubmitEvent } from 'react';
import { pathOfId } from '../router.js';
import { ErrorNotice, Link, Time, useConsole } from '../ui/common.js';

export function LookupPage() {
  const { client, navigate } = useConsole();
  const [query, setQuery] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<AdminUserLookup | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const value = query.trim();
    setProblem(null);
    setError(null);
    setResult(null);
    const path = pathOfId(value);
    if (path !== null) {
      navigate(path);
      return;
    }
    if (!/^[^@\s]+@[^@\s]+$/.test(value) || value.length > 254) {
      setProblem('Enter a usr_, wsp_ or ses_ id, or an e-mail address.');
      return;
    }
    setBusy(true);
    try {
      setResult(await client.lookupUser(value));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Look up</h1>
      <form onSubmit={(e) => void submit(e)} className="inline-form" role="search">
        <label htmlFor="lookup-query">User, workspace or session id, or e-mail address</label>
        <input
          id="lookup-query"
          value={query}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="lookup-problem"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          Look up
        </button>
        <p id="lookup-problem" className="field-error">
          {problem}
        </p>
      </form>
      {error === null ? null : <ErrorNotice error={error} />}
      {result === null ? null : result.data.length === 0 ? (
        <p role="status">No user has that address.</p>
      ) : (
        <table>
          <caption>Users with that address</caption>
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">E-mail</th>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {result.data.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link to={`/users/${u.id}`}>
                    <code>{u.id}</code>
                  </Link>
                </td>
                <td>{u.email}</td>
                <td>{u.display_name}</td>
                <td>{u.status}</td>
                <td>
                  <Time at={u.created_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
