# Device registry (B020)

A user's devices (CLI, TUI, browser), their public keys for session peers, and revocation
([CT-API-ACCOUNTS](../../../../../contracts/02-rest-api.md), [CT-AUTH](../../../../../contracts/01-auth-rbac.md),
fingerprints per [CT-CRYPTO](../../../../../contracts/05-crypto.md)).

## Interface

- `DeviceService.registerDevice({userId, name, platform, x25519, ed25519})`: checks both keys
  (32 bytes, canonical base64url, not all zero), the name (1 to 80 characters) and the platform,
  and stores the device with its fingerprint. A bad field is 422 `validation_failed` with its
  pointer (`/x25519`, `/ed25519`, `/name`, `/platform`). Keys never change afterwards: a new key is
  a new device (trust on first use).
- `touchDevice(id)`: `last_seen_at`, written at most once per 5 minutes per device (a bounded
  in-process memory, then a conditional update that also holds across instances).
- `list`, `get`, `keys`, `revokeDevice(actorUserId, deviceId)`.
- `deviceFingerprint(x25519, ed25519)`: the first 12 base32 characters of
  BLAKE2b-256(X25519 ‖ Ed25519), as `ABCD-EFGH-IJKL`.
- Pub/sub channel `devices:revoked`, message `{"device":"dev_…","user":"usr_…"}`.

Routes: `routes/devices.ts` (`/v1/devices`, `/v1/devices/{id}`, `/v1/devices/{id}/keys`) and
`routes/auth-devices.ts` (`/v1/auth/devices`, `/v1/auth/devices/{id}`, the CT-AUTH aliases).

## Rules

- A user sees only their own devices: another user's id, an unknown id or a malformed one is
  404 `not_found`, never 403. API keys get 403 (machine principals have no devices).
- Public keys go to the owner and to users with a row in the same session (`session_members`,
  left members included), also for revoked devices (`revoked: true`), so history keeps verifying.
- Revocation sets `revoked_at` once. Then:
  1. the call that set it publishes on `devices:revoked`, retried in the background (6 attempts,
     0.5 to 8 s apart) when Redis fails;
  2. the token service revokes the refresh families and flags the access tokens `device_revoked`;
     this runs on every call, so a retry finishes a revocation that failed half way;
  3. the `auth.device_revoked` audit event is queued (B036 `emitDetached`, never blocking).

## Failure modes

- Database down or a statement over `statement_timeout`: 503 (`deviceStoreFromDb`).
- Redis publish fails: the revocation stands and the publish is retried; after the last attempt
  the failure is logged (`devices.revoke_publish_failed`) and the relay sees `revoked_at` on its
  next membership check.
- Token step fails after `revoked_at` is set: 503; DELETE again (idempotent) completes it.

## Wiring

```ts
const devices = new DeviceService({
  store: deviceStoreFromDb(db),
  tokens,
  pubsub: redis.pubsub,
  audit: auditEmitter,
  logger,
  metrics,
});
await app.register(deviceRoutes, { devices, cursorKeys });
await app.register(authDeviceRoutes, { devices, cursorKeys });
// at shutdown: await devices.drain();
```

## Tests

`apps/api/test/modules/devices/`: `fingerprint`, `pubkeys`, `service`, `keys-access`,
`revoke-integration`, `routes`, `repo` (error mapping), and `postgres` (when `DATABASE_URL` is
set).
