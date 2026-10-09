/**
 * Relay modules (B037): how relay lanes plug in without touching each other's files. Each lane
 * puts a folder under `src/` whose `module.ts` default-exports a `RelayModule`; at startup every
 * `src/<lane>/module.(ts|js)` is loaded, sorted by `order` (then name), and its `register(ctx)` called
 * once with the shared `RelayContext`: the place to add pipeline stages, connection handlers and
 * shutdown steps. A module that fails to load or to register stops the startup, naming it.
 *
 * Owns: discovery, ordering and registration. Must not: hold global state: everything a module
 * needs comes through the context.
 */
import { access, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Logger, Metrics, RedisBackend } from '@centcom/core';
import type { CoreDatabase, createDb } from '@centcom/db';
import type { RelayConfig } from './config.js';
import type { ConnectionRegistry } from './connection-registry.js';
import type { FanOut } from './fanout/fanout.js';
import type { FramePipeline, RelayConnection } from './pipeline.js';
import type { SeqService } from './seq/types.js';

/** The relay's database client (Kysely over the core tables). */
export type RelayDb = ReturnType<typeof createDb<CoreDatabase>>;

/** What every module is given. */
export interface RelayContext {
  config: RelayConfig;
  log: Logger;
  metrics: Metrics;
  /** Milliseconds since the epoch. */
  clock: () => number;
  redis: RedisBackend;
  db: RelayDb;
  connections: ConnectionRegistry;
  pipeline: FramePipeline;
  /** Adds a step run on shutdown, after the connections are closed. */
  onShutdown(fn: () => Promise<void>): void;
  /** Adds a handler run for every accepted connection. */
  onConnection(handler: (connection: RelayConnection) => void): void;
  /**
   * Sequencing (B041): set by the sequence module when it registers (order 40), for the modules
   * after it (B042 resume, B044 fan-out); undefined before then and on relays without it.
   */
  seq?: SeqService;
  /**
   * Fan-out (B044): set by the fan-out module when it registers (order 50), for the modules after
   * it (B042 resume, B047 presence, B051 control); undefined before then and on relays without it.
   */
  fanout?: FanOut;
}

/** A relay lane's plug-in: the default export of `src/<lane>/module.ts`. */
export interface RelayModule {
  name: string;
  /** Registration order, lowest first (an integer). */
  order: number;
  register(ctx: RelayContext): Promise<void> | undefined;
}

/** A module failed to load or to register; startup stops. */
export class ModuleError extends Error {
  constructor(
    readonly module: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModuleError';
  }
}

/** The folder modules are found in: this file's (src/ or dist/). */
export const MODULES_DIR = fileURLToPath(new URL('.', import.meta.url));

const isModule = (value: unknown): value is RelayModule => {
  const m = value as Partial<RelayModule> | null;
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof m.name === 'string' &&
    m.name !== '' &&
    Number.isInteger(m.order) &&
    typeof m.register === 'function'
  );
};

/**
 * Loads `<dir>/<folder>/module.<ext>` (ext: this file's, `.ts` in tests and `.js` once built), sorted by
 * order then name. Throws a ModuleError for a file that does not default-export a RelayModule.
 */
export async function discoverModules(dir: string = MODULES_DIR): Promise<RelayModule[]> {
  const ext = extname(fileURLToPath(import.meta.url));
  const folders = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const modules: RelayModule[] = [];
  for (const folder of folders) {
    const file = join(dir, folder, `module${ext}`);
    let loaded: { default?: unknown };
    try {
      loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' && !(await exists(file))) {
        continue;
      }
      throw new ModuleError(folder, `relay module ${folder} failed to load`, { cause: err });
    }
    if (!isModule(loaded.default)) {
      throw new ModuleError(folder, `relay module ${folder} does not export a RelayModule`);
    }
    modules.push(loaded.default);
  }
  return sortModules(modules);
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** `modules` by order, then name; a TypeError for two modules of one name. */
export function sortModules(modules: readonly RelayModule[]): RelayModule[] {
  const names = new Set<string>();
  for (const m of modules) {
    if (names.has(m.name)) throw new TypeError(`relay module ${m.name} is registered twice`);
    names.add(m.name);
  }
  return [...modules].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Registers `modules` in order; a ModuleError naming the first one that throws. */
export async function registerModules(
  modules: readonly RelayModule[],
  ctx: RelayContext,
): Promise<void> {
  for (const m of sortModules(modules)) {
    try {
      await m.register(ctx);
    } catch (err) {
      throw new ModuleError(m.name, `relay module ${m.name} failed to register`, { cause: err });
    }
    ctx.log.info({ module: m.name, order: m.order }, 'relay.module_registered');
  }
}
