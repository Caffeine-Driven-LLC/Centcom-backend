/**
 * `/incidents`: open a status incident or add an update to one (B086 through the admin API).
 * Incidents are public: titles and updates must never hold customer data (the API refuses e-mail
 * and IP addresses and credentials). The admin API has no incident list; open incidents are on the
 * public status page.
 */
import { useState } from 'react';
import { INCIDENT_STATUSES, type Incident, type IncidentStatus } from '../api/client.js';
import { WriteAction } from '../ui/action.js';
import { useConsole } from '../ui/common.js';
import { isId } from '../api/token.js';

function Created({ incident }: { incident: Incident }) {
  return (
    <>
      Incident <code>{incident.id}</code> is {incident.status} ({incident.updates.length} updates).
    </>
  );
}

function StatusSelect({
  id,
  value,
  onChange,
  optional,
}: {
  id: string;
  value: string;
  onChange(value: string): void;
  optional?: boolean;
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {optional === true ? <option value="">(unchanged)</option> : null}
      {INCIDENT_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

export function IncidentsPage() {
  const { client, canWrite } = useConsole();
  const [title, setTitle] = useState('');
  const [components, setComponents] = useState('');
  const [status, setStatus] = useState<string>('investigating');
  const [incidentId, setIncidentId] = useState('');
  const [text, setText] = useState('');
  const [updateStatus, setUpdateStatus] = useState('');
  if (!canWrite) {
    return (
      <>
        <h1>Incidents</h1>
        <p>
          Your role can read only; opening or updating incidents needs support_rw or superadmin.
        </p>
      </>
    );
  }
  const componentIds = components
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  return (
    <>
      <h1>Incidents</h1>
      <section aria-labelledby="incident-new">
        <h2 id="incident-new">Open an incident</h2>
        <form onSubmit={(e) => e.preventDefault()}>
          <label htmlFor="incident-title">Title (public, up to 120 characters)</label>
          <input
            id="incident-title"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
          <label htmlFor="incident-components">Components (comma-separated ids)</label>
          <input
            id="incident-components"
            value={components}
            autoComplete="off"
            onChange={(e) => setComponents(e.target.value)}
          />
          <label htmlFor="incident-status">Status</label>
          <StatusSelect id="incident-status" value={status} onChange={setStatus} />
          {title.trim() !== '' && componentIds.length > 0 ? (
            <WriteAction
              label="Open incident"
              run={() =>
                client.createIncident({
                  title: title.trim(),
                  component_ids: componentIds,
                  status: status as IncidentStatus,
                })
              }
              done={(incident) => <Created incident={incident} />}
            />
          ) : null}
        </form>
      </section>
      <section aria-labelledby="incident-update">
        <h2 id="incident-update">Add an update</h2>
        <form onSubmit={(e) => e.preventDefault()}>
          <label htmlFor="update-incident">Incident id</label>
          <input
            id="update-incident"
            value={incidentId}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setIncidentId(e.target.value.trim())}
          />
          <label htmlFor="update-text">Update (public, up to 500 characters)</label>
          <textarea
            id="update-text"
            value={text}
            maxLength={500}
            rows={3}
            onChange={(e) => setText(e.target.value)}
          />
          <label htmlFor="update-status">New status</label>
          <StatusSelect
            id="update-status"
            value={updateStatus}
            onChange={setUpdateStatus}
            optional
          />
          {isId('inc', incidentId) && text.trim() !== '' ? (
            <WriteAction
              label="Add update"
              run={() =>
                client.addIncidentUpdate(incidentId, {
                  text: text.trim(),
                  ...(updateStatus === '' ? {} : { status: updateStatus as IncidentStatus }),
                })
              }
              done={(incident) => <Created incident={incident} />}
            />
          ) : null}
        </form>
      </section>
    </>
  );
}
