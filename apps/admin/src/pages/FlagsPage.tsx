/**
 * `/flags`: set or delete a feature flag by key (B083's definitions, through the admin API).
 *
 * The admin API has no flag list (B087 routes are PUT and DELETE only), so the editor works by
 * key; listing flags is a gap filed against B087. Read-only staff see why nothing is editable.
 */
import { useState } from 'react';
import { WriteAction } from '../ui/action.js';
import { useConsole } from '../ui/common.js';

const FLAG_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const EXAMPLE = '{\n  "type": "bool",\n  "value": true,\n  "default": false,\n  "public": true\n}';

/** The definition in `text`: a JSON object, or a message saying what is wrong. */
function parseDefinition(text: string): Record<string, unknown> | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'The definition is not valid JSON.';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'The definition must be a JSON object.';
  }
  return value as Record<string, unknown>;
}

export function FlagsPage() {
  const { client, canWrite } = useConsole();
  const [key, setKey] = useState('');
  const [definition, setDefinition] = useState(EXAMPLE);
  const keyOk = FLAG_KEY.test(key);
  const parsed = parseDefinition(definition);
  return (
    <>
      <h1>Feature flags</h1>
      {!canWrite ? (
        <p>Your role can read only; changing flags needs support_rw or superadmin.</p>
      ) : (
        <form onSubmit={(e) => e.preventDefault()}>
          <label htmlFor="flag-key">Flag key</label>
          <input
            id="flag-key"
            value={key}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="flag-key-help"
            onChange={(e) => setKey(e.target.value)}
          />
          <p id="flag-key-help" className="muted">
            Lower-case letters, digits and . _ - (up to 64).
          </p>
          <label htmlFor="flag-definition">Definition (JSON)</label>
          <textarea
            id="flag-definition"
            value={definition}
            rows={8}
            spellCheck={false}
            aria-describedby="flag-definition-problem"
            onChange={(e) => setDefinition(e.target.value)}
          />
          <p id="flag-definition-problem" className="field-error">
            {typeof parsed === 'string' ? parsed : null}
          </p>
          {keyOk && typeof parsed !== 'string' ? (
            <WriteAction
              label="Set flag"
              run={() => client.putFlag(key, parsed)}
              done={(r) => `Flag ${r.key} set (revision ${r.rev}).`}
            />
          ) : null}
          {keyOk ? (
            <WriteAction
              label="Delete flag"
              confirmTarget={key}
              run={() => client.deleteFlag(key)}
              done={(r) => `Flag ${r.key} deleted (revision ${r.rev}).`}
            />
          ) : null}
        </form>
      )}
    </>
  );
}
