/**
 * `/sessions/:id`: a session's metadata (never its name or content). Writers may end it, after
 * typing its id.
 */
import { WriteAction } from '../ui/action.js';
import { Fields, IdText, LoadedView, Time, useConsole, useLoad } from '../ui/common.js';

export function SessionPage({ id }: { id: string }) {
  const { client, canWrite } = useConsole();
  const loaded = useLoad((c) => c.session(id), id);
  return (
    <>
      <h1>
        Session <code>{id}</code>
      </h1>
      <LoadedView loaded={loaded}>
        {(s) => (
          <>
            <Fields
              rows={[
                ['Workspace', <IdText key="w" id={s.workspace} />],
                ['State', s.state],
                ['Region', s.region],
                ['Created', <Time key="c" at={s.created_at} />],
                ['Ended', <Time key="e" at={s.ended_at} />],
                ['Members', String(s.member_count)],
                ['Host member', s.host_member ?? 'none'],
              ]}
            />
            {canWrite && s.state !== 'ended' && s.state !== 'expired' ? (
              <WriteAction
                label="End session"
                confirmTarget={s.id}
                run={async () => {
                  const r = await client.endSession(s.id);
                  loaded.reload();
                  return r;
                }}
                done={() => 'Session ended.'}
              />
            ) : null}
          </>
        )}
      </LoadedView>
    </>
  );
}
