/**
 * Which tests prove which contract (B100). One entry per contract that `contracts/index.json` lists as
 * implemented by the backend; a test fails when a backend contract has no entry, or an entry names a path
 * that does not exist. A path is a test file or a folder (vitest takes it as a filter).
 *
 * The suites named here already run the contract's fixtures and wire behaviour in their own lanes; this
 * map is what lets one command run them as a set and report per contract.
 */

/** Evidence for one contract. */
export interface ContractEvidence {
  /** Test files or folders (relative to the repository root). */
  tests: readonly string[];
  /** Fixture folders under `contracts/fixtures` this contract's suites consume. */
  fixtures?: readonly string[];
}

export const CONFORMANCE_MAP: Readonly<Record<string, ContractEvidence>> = {
  'CT-IDS': {
    tests: [
      'packages/contracts/test/ids.test.ts',
      'packages/contracts/test/time-money-text.test.ts',
    ],
  },
  'CT-ERR': {
    tests: ['packages/core/test/errors', 'apps/api/test/error-handler.test.ts'],
    fixtures: ['problem'],
  },
  'CT-VER': {
    tests: [
      'packages/contracts/test/validate.test.ts',
      'apps/relay/test/handshake/handshake.negotiation.test.ts',
    ],
  },
  'CT-PAGE': { tests: ['packages/core/test/pagination', 'apps/api/test/pagination.test.ts'] },
  'CT-STATUS': { tests: ['apps/api/test/status', 'apps/relay/test/relay.health.test.ts'] },
  'CT-AUTH': {
    tests: [
      'apps/api/test/modules/auth',
      'apps/api/test/modules/apikeys',
      'apps/api/test/modules/devices',
    ],
  },
  'CT-RBAC': { tests: ['packages/core/test/rbac', 'apps/api/test/rbac-plugin.test.ts'] },
  'CT-API-ACCOUNTS': {
    tests: [
      'apps/api/test/routes/me.test.ts',
      'apps/api/test/account-lifecycle',
      'apps/api/test/modules/users',
    ],
  },
  'CT-API-WORKSPACES': {
    tests: [
      'apps/api/test/modules/workspaces',
      'apps/api/test/modules/members',
      'apps/api/test/modules/invites',
      'apps/api/test/modules/seats',
      'apps/api/test/modules/projects',
    ],
  },
  'CT-API-SESSIONS': {
    tests: [
      'apps/api/test/routes/sessions',
      'apps/api/test/sessions',
      'apps/api/test/share-links',
      'apps/api/test/history',
      'apps/api/test/snapshots',
    ],
  },
  'CT-API-BILLING': {
    tests: ['apps/api/test/billing', 'apps/api/test/entrypoint/billing.e2e.test.ts'],
  },
  'CT-API-USAGE': { tests: ['apps/api/test/usage'] },
  'CT-API-AUDIT': { tests: ['apps/api/test/audit-api'] },
  'CT-API-NOTIFY': { tests: ['apps/api/test/notifications'] },
  'CT-API-WEBHOOKS': { tests: ['apps/api/test/webhooks'], fixtures: ['webhook'] },
  'CT-API-RELEASES': { tests: ['apps/api/test/releases'], fixtures: ['release'] },
  'CT-API-FLAGS': { tests: ['apps/api/test/flags'] },
  'CT-WS-ENVELOPE': {
    tests: ['apps/relay/test/codec', 'apps/relay/test/handshake', 'apps/relay/test/connection'],
    fixtures: ['envelope'],
  },
  'CT-RESUME': { tests: ['apps/relay/test/resume', 'apps/relay/test/seq'] },
  'CT-WS-SESSION-EVENTS': {
    tests: [
      'apps/relay/test/fanout',
      'apps/relay/test/privacy',
      'apps/relay/test/rooms',
      'apps/relay/test/board',
      'apps/relay/test/reactions',
      'apps/relay/test/agents',
      'apps/relay/test/branches',
      'apps/relay/test/locks',
    ],
    fixtures: ['events'],
  },
  'CT-WS-PRESENCE': { tests: ['apps/relay/test/presence', 'apps/relay/test/cursors'] },
  'CT-WS-QUEUE': { tests: ['apps/relay/test/queue', 'apps/relay/test/approvals'] },
  'CT-WS-CONTROL': { tests: ['apps/relay/test/control', 'apps/relay/test/keys'] },
  'CT-ENTITLEMENTS': {
    tests: ['apps/api/test/entitlements', 'packages/core/test/entitlements'],
    fixtures: ['entitlements'],
  },
  'CT-WEBHOOKS': { tests: ['apps/api/test/webhooks', 'packages/core/test/webhooks'] },
  'CT-NOTIF-PAYLOAD': {
    tests: ['apps/api/test/notifications/dispatcher', 'apps/worker/test/notify-dispatch.test.ts'],
    fixtures: ['notification'],
  },
  'CT-TELEMETRY': { tests: ['apps/api/test/telemetry'], fixtures: ['telemetry'] },
  'CT-DEEPLINK': { tests: ['apps/api/test/modules/deeplinks', 'packages/core/test/deeplink'] },
};

/** The test sets of the provider-side integration gates G1 to G5. */
export const GATE_TESTS: Readonly<
  Record<'G1' | 'G2' | 'G3' | 'G4' | 'G5', { title: string; tests: readonly string[] }>
> = {
  G1: {
    title:
      'Device sign-in: start, approve in the browser with a mailed link, poll, tokens, GET /v1/me, refresh, revoke',
    tests: [
      'apps/api/test/entrypoint/login.e2e.test.ts',
      'apps/api/test/modules/auth/device',
      'apps/api/test/routes/me.test.ts',
    ],
  },
  G2: {
    title: 'Relay: handshake, heartbeat, forced disconnect and resume with a gap-free seq',
    tests: [
      'apps/relay/test/handshake',
      'apps/relay/test/connection',
      'apps/relay/test/resume',
      'apps/relay/test/seq',
      'apps/relay/test/relay.shutdown.test.ts',
    ],
  },
  G3: {
    title:
      'Command post: queue submit, approve, agent events fan out, no plaintext in relay logs or stores',
    tests: [
      'apps/relay/test/queue',
      'apps/relay/test/approvals',
      'apps/relay/test/fanout',
      'apps/relay/test/privacy',
    ],
  },
  G4: {
    title: 'Billing: checkout, signed webhook, entitlement change, plan limits, usage warnings',
    tests: [
      'apps/api/test/entrypoint/billing.e2e.test.ts',
      'apps/api/test/entitlements',
      'apps/api/test/billing/webhooks',
      'apps/api/test/billing/quota',
      'apps/api/test/usage',
    ],
  },
  G5: {
    title:
      'Collaboration: branch mode, file locks, presence, notifications, signed outgoing webhooks',
    tests: [
      'apps/relay/test/branches',
      'apps/relay/test/branch-mode',
      'apps/relay/test/locks',
      'apps/relay/test/presence',
      'apps/api/test/notifications',
      'apps/api/test/webhooks',
    ],
  },
};
