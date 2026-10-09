/**
 * Relay modules (B037, card test relay.modules.test.ts, acceptance 6): modules of orders 30 and 10
 * are registered 10 first; a module that throws in `register` stops the startup with an error and
 * a log line naming it, before anything listens. Discovery finds `<folder>/module.ts`, skips
 * folders without one and refuses a bad export. The context reaches the pipeline (stages run by
 * order), the connection handlers and the shutdown steps.
 */
import { fileURLToPath } from 'node:url';
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  discoverModules,
  FramePipeline,
  ModuleError,
  registerModules,
  sortModules,
  startRelay,
  type FrameContext,
  type RelayContext,
  type RelayDb,
  type RelayModule,
} from '../src/index.js';
import { registrations } from './fixtures/modules/registrations.js';
import { captureLogger, connect, stubProbe, testConfig, testRelay, until } from './helpers.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/modules/', import.meta.url));
const BAD_FIXTURES = fileURLToPath(new URL('./fixtures/bad-modules/', import.meta.url));

const recorder = (name: string, order: number, calls: string[]): RelayModule => ({
  name,
  order,
  register() {
    calls.push(name);
    return undefined;
  },
});

const context = (): RelayContext => ({}) as RelayContext;

describe('registration order (acceptance 6)', () => {
  it('registers orders 30 and 10 as 10 then 30, ties by name', async () => {
    const calls: string[] = [];
    const log = captureLogger();
    await registerModules(
      [recorder('thirty', 30, calls), recorder('ten', 10, calls), recorder('also-ten', 10, calls)],
      { ...context(), log: log.logger },
    );
    expect(calls).toEqual(['also-ten', 'ten', 'thirty']);
    expect(log.lines().map((l) => l['module'])).toEqual(['also-ten', 'ten', 'thirty']);
  });

  it('refuses two modules of one name', () => {
    expect(() => sortModules([recorder('a', 1, []), recorder('a', 2, [])])).toThrow(TypeError);
  });

  it('stops at a module that throws, naming it, before anything listens', async () => {
    const calls: string[] = [];
    const failing: RelayModule = {
      name: 'failing',
      order: 20,
      register: () => Promise.reject(new Error('cannot register')),
    };
    const log = captureLogger();
    const started = startRelay({
      config: testConfig(),
      host: '127.0.0.1',
      logger: log.logger,
      redis: createMemoryRedis(),
      db: {} as RelayDb,
      probe: stubProbe(),
      modules: [recorder('first', 10, calls), failing, recorder('never', 30, calls)],
    });
    const err = await started.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModuleError);
    expect((err as ModuleError).module).toBe('failing');
    expect((err as ModuleError).message).toContain('failing');
    expect(calls).toEqual(['first']);
    expect(log.lines().some((l) => l['msg'] === 'relay.started')).toBe(false);
  });
});

describe('discovery', () => {
  it('loads <folder>/module.ts, sorted by order, skipping folders without one', async () => {
    const modules = await discoverModules(FIXTURES);
    expect(modules.map((m) => [m.name, m.order])).toEqual([
      ['beta', 10],
      ['alpha', 30],
    ]);
    registrations.length = 0;
    await registerModules(modules, { ...context(), log: captureLogger().logger });
    expect(registrations).toEqual(['beta', 'alpha']);
  });

  it('refuses a module file whose default export is not a RelayModule, naming the folder', async () => {
    const err = await discoverModules(BAD_FIXTURES).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModuleError);
    expect((err as ModuleError).module).toBe('broken');
  });

  it('finds the relay lanes’ modules in src/, by order (B039: the codec at 10, B040: the connection at 12, B038: the handshake at 15, B043: the rooms at 20, B041: sequencing at 40, B042: resume at 45, B044: fan-out at 50)', async () => {
    const found = await discoverModules();
    expect(found.map((m) => [m.name, m.order])).toEqual([
      ['codec', 10],
      ['connection', 12],
      ['handshake', 15],
      ['rooms', 20],
      ['seq', 40],
      ['resume', 45],
      ['fanout', 50],
    ]);
  });
});

describe('the context', () => {
  it('runs stages by order, hands each connection to the handlers, and keeps shutdown steps', async () => {
    const seen: string[] = [];
    const late: RelayModule = {
      name: 'late',
      order: 30,
      register(ctx) {
        ctx.pipeline.use(50, (fc, next) => {
          seen.push(`fan-out:${String(fc.state['decoded'])}`);
          fc.connection.send({ v: 1, t: 'sys.notice', p: { code: 'echo' } });
          return next();
        });
        ctx.onShutdown(() => Promise.resolve());
        return undefined;
      },
    };
    const early: RelayModule = {
      name: 'early',
      order: 10,
      register(ctx) {
        expect(ctx.config.region).toBe('test');
        expect(ctx.connections.size).toBe(0);
        expect(typeof ctx.clock()).toBe('number');
        ctx.pipeline.use(10, async (fc, next) => {
          seen.push('decode');
          fc.state['decoded'] = fc.raw?.length ?? -1;
          await next();
        });
        ctx.onConnection((connection) => seen.push(`connection:${connection.entry.state}`));
        return undefined;
      },
    };
    const relay = await testRelay({ modules: [late, early] });
    try {
      expect(relay.shutdownSteps).toHaveLength(1);
      const client = connect(relay.url);
      await client.opened;
      client.ws.send('hello');
      await until(() => client.messages.length === 1);
      expect(seen).toEqual(['connection:open', 'decode', 'fan-out:5']);
      client.ws.close();
      await client.closed;
    } finally {
      await relay.stop();
    }
  });
});

describe('FramePipeline', () => {
  const fc = (): FrameContext => ({
    connection: {} as FrameContext['connection'],
    raw: '',
    state: {},
  });

  it('runs stages by order, then by the order they were added', async () => {
    const pipeline = new FramePipeline();
    const ran: string[] = [];
    const stage = (name: string) => async (_fc: FrameContext, next: () => Promise<void>) => {
      ran.push(name);
      await next();
    };
    pipeline.use(40, stage('sequence'));
    pipeline.use(10, stage('decode'));
    pipeline.use(40, stage('sequence-2'));
    pipeline.use(15, stage('handshake'));
    expect(pipeline.orders()).toEqual([10, 15, 40, 40]);
    await pipeline.run(fc());
    expect(ran).toEqual(['decode', 'handshake', 'sequence', 'sequence-2']);
  });

  it('stops where a stage does not call next, and refuses next twice and bad orders', async () => {
    const pipeline = new FramePipeline();
    const ran: string[] = [];
    pipeline.use(10, () => {
      ran.push('stop');
      return Promise.resolve();
    });
    pipeline.use(20, () => {
      ran.push('never');
      return Promise.resolve();
    });
    await pipeline.run(fc());
    expect(ran).toEqual(['stop']);
    const twice = new FramePipeline();
    twice.use(10, async (_fc, next) => {
      await next();
      await next();
    });
    await expect(twice.run(fc())).rejects.toThrow(/twice/);
    for (const order of [-1, 1.5, 1001, Number.NaN]) {
      expect(() => pipeline.use(order, () => Promise.resolve())).toThrow(TypeError);
    }
  });
});
