/**
 * Renders the console (B088 tests) against the fake admin API installed as the global `fetch`, and
 * walks the sign-in: token, then the reason dialog the first call asks for.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { App } from '../src/App.js';
import { API, FakeAdminApi } from './fake-api.js';

export const REASON = 'Customer ticket about a missing seat';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
  delete document.documentElement.dataset['theme'];
});

/** The console at `path`, talking to `api` (the global fetch). */
export function renderConsole(
  api: FakeAdminApi,
  opts: { path?: string; idleMs?: number; fakeTimers?: boolean } = {},
) {
  window.history.replaceState(null, '', opts.path ?? '/');
  vi.stubGlobal('fetch', api.fetch);
  const user = userEvent.setup(
    opts.fakeTimers === true ? { advanceTimers: vi.advanceTimersByTime.bind(vi) } : {},
  );
  render(
    <App
      config={{ apiBase: API, ...(opts.idleMs === undefined ? {} : { idleMs: opts.idleMs }) }}
    />,
  );
  return { user };
}

type User = ReturnType<typeof userEvent.setup>;

/** Pastes `token`, submits, and answers the reason dialog (or cancels it with `reason: null`). */
export async function signIn(
  user: User,
  token: string,
  reason: string | null = REASON,
  ticket?: string,
) {
  await user.click(screen.getByLabelText('Staff access token'));
  await user.paste(token);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  const dialog = await screen.findByRole('dialog', { name: 'Why are you looking?' });
  if (reason === null) {
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    return;
  }
  await user.type(within(dialog).getByLabelText(/^Reason/), reason);
  if (ticket !== undefined) await user.type(within(dialog).getByLabelText(/^Ticket/), ticket);
  await user.click(within(dialog).getByRole('button', { name: 'Use this reason' }));
  await screen.findByRole('navigation', { name: 'Main' });
}

/** Follows an in-app link by its text. */
export async function follow(user: User, name: string | RegExp) {
  await user.click(screen.getByRole('link', { name }));
}
