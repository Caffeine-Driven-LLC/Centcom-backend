/**
 * `/workspaces/:id`: a workspace, its members and roles, plan, subscription status, entitlements
 * and usage. Writers may grant a promotion (B079 through the admin API).
 */
import type { AdminWorkspace } from '@centcom/api';
import { useState, type ReactNode } from 'react';
import { WriteAction } from '../ui/action.js';
import { Fields, LoadedView, Link, Plain, Time, useConsole, useLoad } from '../ui/common.js';

export function WorkspacePage({ id }: { id: string }) {
  const loaded = useLoad((client) => client.workspace(id), id);
  return (
    <>
      <h1>
        Workspace <code>{id}</code>
      </h1>
      <LoadedView loaded={loaded}>{(ws) => <WorkspaceView ws={ws} />}</LoadedView>
    </>
  );
}

function WorkspaceView({ ws }: { ws: AdminWorkspace }) {
  const { canWrite } = useConsole();
  const ent = ws.entitlements;
  return (
    <>
      <Fields
        rows={[
          ['Name', ws.name],
          ['Slug', ws.slug],
          ['Created', <Time key="c" at={ws.created_at} />],
          ['Deleted', <Time key="d" at={ws.deleted_at} />],
          ['Plan', ws.plan ?? 'none'],
          ['Subscription', ws.subscription_status ?? 'none'],
          ['Members', String(ws.member_count)],
        ]}
      />
      <section aria-labelledby="ws-entitlements">
        <h2 id="ws-entitlements">Entitlements</h2>
        {ent === null ? (
          <p>No entitlements.</p>
        ) : (
          <Fields
            rows={[
              ['Revision', String(ent.rev)],
              [
                'Period',
                ent.period === null ? (
                  'none'
                ) : (
                  <span key="p">
                    <Time at={ent.period.start} /> to <Time at={ent.period.end} />
                  </span>
                ),
              ],
              ['Grace until', <Time key="g" at={ent.grace_until} />],
              ...Object.entries(ent.limits).map(([k, v]): [string, ReactNode] => [
                k,
                <Plain key={k} value={v} />,
              ]),
            ]}
          />
        )}
      </section>
      <section aria-labelledby="ws-usage">
        <h2 id="ws-usage">Usage this period</h2>
        {ws.usage === null ? (
          <p>No usage recorded.</p>
        ) : (
          <Fields
            rows={Object.entries(ws.usage).map(([k, v]): [string, ReactNode] => [
              k,
              <Plain key={k} value={v} />,
            ])}
          />
        )}
      </section>
      {canWrite ? <Promotion workspaceId={ws.id} /> : null}
      <section aria-labelledby="ws-members">
        <h2 id="ws-members">Members</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">E-mail</th>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Joined</th>
            </tr>
          </thead>
          <tbody>
            {ws.members.map((m) => (
              <tr key={m.member}>
                <td>
                  <Link to={`/users/${m.user}`}>
                    <code>{m.user}</code>
                  </Link>
                </td>
                <td>{m.email}</td>
                <td>{m.display_name}</td>
                <td>{m.role}</td>
                <td>
                  <Time at={m.joined_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {ws.members_truncated ? (
          <p className="muted">Showing the first {ws.members.length} members.</p>
        ) : null}
      </section>
    </>
  );
}

function Promotion({ workspaceId }: { workspaceId: string }) {
  const { client } = useConsole();
  const [code, setCode] = useState('');
  const valid = /^[A-Za-z0-9_-]{1,100}$/.test(code.trim());
  return (
    <section aria-labelledby="ws-promotion">
      <h2 id="ws-promotion">Grant a promotion</h2>
      <label htmlFor="promotion-code">Promotion code id</label>
      <input
        id="promotion-code"
        value={code}
        autoComplete="off"
        onChange={(e) => setCode(e.target.value)}
      />
      {valid ? (
        <WriteAction
          label="Grant promotion"
          run={() => client.grantPromotion(workspaceId, code.trim())}
          done={(r) => `Granted: ${r.subscription.plan}, ${r.subscription.status}.`}
        />
      ) : null}
    </section>
  );
}
