/**
 * `/staff-audit`: the admin API's own audit (B087), newest first, by page, filtered by actor or
 * target id. Reasons and tickets are staff-written text and shown as text.
 */
import type { StaffAuditEntry } from '@centcom/api';
import { useState } from 'react';
import { isId } from '../api/token.js';
import { ErrorNotice, IdText, Time, useLoad } from '../ui/common.js';

const ANY_ID = /^[a-z]{2,8}_[0-9A-HJKMNP-TV-Z]{26}$/;

export function StaffAuditPage({ initialTarget }: { initialTarget: string | null }) {
  const [actor, setActor] = useState('');
  const [target, setTarget] = useState(initialTarget ?? '');
  const [filters, setFilters] = useState({ actor: '', target: initialTarget ?? '' });
  const [problem, setProblem] = useState<string | null>(null);
  const apply = () => {
    if ((actor !== '' && !isId('usr', actor)) || (target !== '' && !ANY_ID.test(target))) {
      setProblem('The actor is a usr_ id and the target any id; leave either empty for all.');
      return;
    }
    setProblem(null);
    setFilters({ actor, target });
  };
  return (
    <>
      <h1>Staff audit</h1>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <label htmlFor="audit-actor">Actor (usr_ id)</label>
        <input
          id="audit-actor"
          value={actor}
          autoComplete="off"
          onChange={(e) => setActor(e.target.value.trim())}
        />
        <label htmlFor="audit-target">Target id</label>
        <input
          id="audit-target"
          value={target}
          autoComplete="off"
          onChange={(e) => setTarget(e.target.value.trim())}
        />
        <button type="submit">Filter</button>
        <p className="field-error">{problem}</p>
      </form>
      <AuditPages
        key={`${filters.actor}|${filters.target}`}
        actor={filters.actor}
        target={filters.target}
      />
    </>
  );
}

function AuditPages({ actor, target }: { actor: string; target: string }) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const loaded = useLoad(
    (c) =>
      c.staffAudit({
        limit: 50,
        ...(actor === '' ? {} : { actor }),
        ...(target === '' ? {} : { target }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    `${actor}|${target}|${cursor ?? ''}`,
  );
  if (loaded.loading) return <p role="status">Loading…</p>;
  if (loaded.data === null) return <ErrorNotice error={loaded.error} />;
  const page = loaded.data;
  return (
    <>
      {page.data.length === 0 ? (
        <p>No staff calls.</p>
      ) : (
        <table>
          <caption>Admin API calls, newest first</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">Call</th>
              <th scope="col">Outcome</th>
              <th scope="col">Target</th>
              <th scope="col">Reason</th>
              <th scope="col">Ticket</th>
            </tr>
          </thead>
          <tbody>
            {page.data.map((e: StaffAuditEntry) => (
              <tr key={e.id}>
                <td>
                  <Time at={e.at} />
                </td>
                <td>
                  {e.actor.type} <IdText id={e.actor.id} />
                </td>
                <td>
                  <code>
                    {e.method} {e.route}
                  </code>
                  {e.flag === null ? null : ` (${e.flag})`}
                </td>
                <td>
                  {e.outcome} {e.status}
                  {e.code === null ? null : ` ${e.code}`}
                </td>
                <td>
                  {e.target === null ? (
                    <span className="muted">none</span>
                  ) : (
                    <IdText id={e.target.id} />
                  )}
                </td>
                <td>{e.reason}</td>
                <td>{e.ticket}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {page.next_cursor === null ? null : (
        <button type="button" onClick={() => setCursor(page.next_cursor ?? undefined)}>
          Older calls
        </button>
      )}
    </>
  );
}
