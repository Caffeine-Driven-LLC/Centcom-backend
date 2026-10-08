/**
 * `/users/:id`: a user, their devices (no keys) and memberships. Writers may revoke every token,
 * revoke one device, or disable sign-in, each after typing the target id.
 */
import type { AdminUser } from '@centcom/api';
import { WriteAction } from '../ui/action.js';
import { Fields, IdText, LoadedView, Link, Time, useConsole, useLoad } from '../ui/common.js';

export function UserPage({ id }: { id: string }) {
  const loaded = useLoad((client) => client.user(id), id);
  return (
    <>
      <h1>
        User <code>{id}</code>
      </h1>
      <LoadedView loaded={loaded}>
        {(user) => <UserView user={user} reload={loaded.reload} />}
      </LoadedView>
    </>
  );
}

function UserView({ user, reload }: { user: AdminUser; reload(): void }) {
  const { client, canWrite } = useConsole();
  return (
    <>
      <Fields
        rows={[
          ['E-mail', user.email],
          ['Name', user.display_name],
          ['Status', user.status],
          ['Created', <Time key="c" at={user.created_at} />],
          ['Deletion requested', <Time key="d" at={user.deletion_requested_at} />],
          ['Sign-in disabled', <Time key="s" at={user.login_disabled_at} />],
          ['Staff role', user.staff_role ?? 'not staff'],
        ]}
      />
      {canWrite ? (
        <section aria-labelledby="user-actions">
          <h2 id="user-actions">Actions</h2>
          <WriteAction
            label="Revoke all tokens"
            confirmTarget={user.id}
            run={() => client.revokeTokens(user.id)}
            done={(r) => `Revoked. Refresh tokens revoked: ${r.revoked_count ?? 0}.`}
          />
          {user.login_disabled_at === null ? (
            <WriteAction
              label="Disable sign-in"
              confirmTarget={user.id}
              run={async () => {
                const r = await client.disableUser(user.id);
                reload();
                return r;
              }}
              done={() => 'Sign-in disabled.'}
            />
          ) : null}
        </section>
      ) : null}
      <section aria-labelledby="user-devices">
        <h2 id="user-devices">Devices</h2>
        {user.devices.length === 0 ? (
          <p>No devices.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Name</th>
                <th scope="col">Platform</th>
                <th scope="col">Created</th>
                <th scope="col">Last seen</th>
                <th scope="col">Revoked</th>
                {canWrite ? <th scope="col">Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {user.devices.map((d) => (
                <tr key={d.id}>
                  <td>
                    <code>{d.id}</code>
                  </td>
                  <td>{d.name}</td>
                  <td>{d.platform}</td>
                  <td>
                    <Time at={d.created_at} />
                  </td>
                  <td>
                    <Time at={d.last_seen_at} />
                  </td>
                  <td>
                    <Time at={d.revoked_at} />
                  </td>
                  {canWrite ? (
                    <td>
                      {d.revoked_at === null ? (
                        <WriteAction
                          label={`Revoke device ${d.id}`}
                          confirmTarget={d.id}
                          run={() => client.revokeTokens(user.id, d.id)}
                          done={() => 'Device revoked.'}
                        />
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="user-memberships">
        <h2 id="user-memberships">Workspaces</h2>
        {user.memberships.length === 0 ? (
          <p>No workspaces.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Role</th>
                <th scope="col">Member</th>
                <th scope="col">Joined</th>
              </tr>
            </thead>
            <tbody>
              {user.memberships.map((m) => (
                <tr key={m.member}>
                  <td>
                    <IdText id={m.workspace} />
                  </td>
                  <td>{m.role}</td>
                  <td>
                    <code>{m.member}</code>
                  </td>
                  <td>
                    <Time at={m.joined_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p>
        <Link to={`/staff-audit?target=${user.id}`}>Staff calls about this user</Link>
      </p>
    </>
  );
}
