/**
 * Whose devices may receive a grant, on Postgres 16 (B049): a device, not revoked, of a user who is
 * a current member of the session; not one of a member who left, of a user outside the session, or
 * a revoked one. A positive answer is reused for 2 s; a negative one is never cached (a new device
 * is granted right after joining). Skipped without a test stack.
 */
import { newId } from '@centcom/contracts';
import { createFactories } from '@centcom/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresSessionDevices, DEVICE_CACHE_MS } from '../../src/keys/devices.js';
import type { RelayDb } from '../../src/modules.js';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';

describe.runIf(STACK)('session devices on Postgres 16', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack();
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  it('a current member’s device, and nothing else', async () => {
    const f = createFactories(stack.db);
    const workspace = await f.workspaces.create();
    const session = await f.sessions.create({ workspace: workspace.id, state: 'live' });
    const member = await f.users.create();
    const device = await f.devices.create({ user: member.id });
    const second = await f.devices.create({ user: member.id });
    await f.sessionMembers.create({
      session: session.id,
      user: member.id,
      device: device.id,
      role: 'editor',
    });
    const leaver = await f.users.create();
    const leaverDevice = await f.devices.create({ user: leaver.id });
    const left = await f.sessionMembers.create({
      session: session.id,
      user: leaver.id,
      device: leaverDevice.id,
      role: 'viewer',
    });
    await stack.db
      .updateTable('session_members')
      .set({ left_at: new Date() })
      .where('id', '=', left.id)
      .execute();
    const stranger = await f.devices.create();
    const revoked = await f.devices.create({ user: member.id });
    await stack.db
      .updateTable('devices')
      .set({ revoked_at: new Date() })
      .where('id', '=', revoked.id)
      .execute();

    let now = 0;
    const devices = createPostgresSessionDevices(stack.db as unknown as RelayDb, () => now);
    expect(await devices.isMemberDevice(session.id, device.id)).toBe(true);
    // Any device of the member's user: a new device is granted right after it joined.
    expect(await devices.isMemberDevice(session.id, second.id)).toBe(true);
    expect(await devices.isMemberDevice(session.id, leaverDevice.id)).toBe(false);
    expect(await devices.isMemberDevice(session.id, stranger.id)).toBe(false);
    expect(await devices.isMemberDevice(session.id, revoked.id)).toBe(false);
    expect(await devices.isMemberDevice(newId('ses'), device.id)).toBe(false);

    // A positive answer is cached for 2 s; after that the database decides again.
    await stack.db
      .updateTable('devices')
      .set({ revoked_at: new Date() })
      .where('id', '=', device.id)
      .execute();
    expect(await devices.isMemberDevice(session.id, device.id)).toBe(true);
    now += DEVICE_CACHE_MS + 1;
    expect(await devices.isMemberDevice(session.id, device.id)).toBe(false);
  });
});
