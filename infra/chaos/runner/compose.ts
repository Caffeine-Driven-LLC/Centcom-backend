/**
 * The Docker side of the runner (B096): faults on the services of one compose project, and HTTP and
 * container probes. It only ever runs `docker compose` for the project and file it was given, and signals
 * nothing but those compose services, so another checkout's stack on the same machine is never touched.
 *
 * Owns: translating faults and checks into docker and fetch calls. Must not: take a container name from
 * a scenario (only compose service names, validated by the schema).
 */
import { spawnSync } from 'node:child_process';
import type { Check, Fault } from './scenario.js';
import type { Injector, Prober } from './engine.js';

export interface ComposeTarget {
  /** `--file`: the production compose file. */
  file: string;
  /** `--env-file`. */
  envFile: string;
  /** `--project-name`: the stack under test (never inferred). */
  project: string;
  /** The profiles to include (bluegreen for the green API). */
  profiles?: string[];
}

/** Runs `docker compose` for `target`; returns the exit code and output. */
export function dockerCompose(
  target: ComposeTarget,
  args: string[],
): { code: number; out: string } {
  const profiles = (target.profiles ?? []).flatMap((p) => ['--profile', p]);
  const r = spawnSync(
    'docker',
    [
      'compose',
      '--project-name',
      target.project,
      '--file',
      target.file,
      '--env-file',
      target.envFile,
      ...profiles,
      ...args,
    ],
    { encoding: 'utf8', timeout: 180_000 },
  );
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

const VERB: Record<Fault['fault'], string[]> = {
  stop: ['stop'],
  kill: ['kill', '--signal', 'KILL'],
  pause: ['pause'],
  restart: ['restart'],
};

export function composeInjector(target: ComposeTarget): Injector {
  return {
    async apply(fault) {
      const r = dockerCompose(target, [...VERB[fault.fault], fault.service]);
      if (r.code !== 0)
        throw new Error(
          `docker compose ${fault.fault} ${fault.service} failed: ${r.out.trim().split('\n').pop()}`,
        );
    },
    async heal(fault) {
      // A paused container is unpaused, a stopped or killed one started again; a restarted one needs nothing.
      if (fault.fault === 'pause') dockerCompose(target, ['unpause', fault.service]);
      if (fault.fault === 'stop' || fault.fault === 'kill')
        dockerCompose(target, ['start', fault.service]);
      return Promise.resolve();
    },
  };
}

/** `chaos heal`: unpauses and starts every service of the project that is not running. */
export function healAll(target: ComposeTarget): string[] {
  const healed: string[] = [];
  const list = dockerCompose(target, ['ps', '--all', '--format', '{{.Service}} {{.State}}']);
  for (const line of list.out.split('\n').filter(Boolean)) {
    const [service, state] = line.trim().split(' ');
    if (service === undefined || state === undefined) continue;
    if (state === 'paused') {
      dockerCompose(target, ['unpause', service]);
      healed.push(`${service} (unpaused)`);
    } else if (state === 'exited' || state === 'dead') {
      // One-shot services (minio-init, migrate) exit by design; only start what restart policy would.
      if (!/^(minio-init|migrate|mailpit)$/.test(service)) {
        dockerCompose(target, ['start', service]);
        healed.push(`${service} (started)`);
      }
    }
  }
  return healed;
}

export function composeProber(
  target: ComposeTarget,
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Prober {
  return {
    async holds(check: Check): Promise<boolean> {
      if (check.http !== undefined) {
        const url = check.http.replace('${API_URL}', apiUrl.replace(/\/+$/, ''));
        let res: Response;
        try {
          res = await fetchImpl(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
        } catch {
          return check.status?.includes(0) === true; // 0 means "no answer at all" is the expected state
        }
        await res.body?.cancel().catch(() => undefined);
        if (!(check.status ?? [200]).includes(res.status)) return false;
        return check.header === undefined || res.headers.has(check.header);
      }
      if (check.service_running !== undefined) {
        const r = dockerCompose(target, [
          'ps',
          '--status',
          'running',
          '--quiet',
          check.service_running,
        ]);
        return (r.out.trim() !== '') === (check.running !== false);
      }
      return false;
    },
  };
}
