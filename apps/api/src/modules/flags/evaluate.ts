/**
 * Flag evaluation (B083): pure and deterministic. The same context and definitions give the same
 * flags, whatever order the definitions come in.
 *
 * For a client (`evaluateFlags`), a flag is first shown or hidden:
 *
 * 1. a `server_only` flag is never shown;
 * 2. an anonymous caller (no user id) is shown only `public` flags without a percent, plan or
 *    workspace rule, so its answer is never per-user (CT-API-FLAGS: fully on or off);
 * 3. a flag with a `client_version` rule is hidden from a client whose version is unknown or out
 *    of range (unless the flag is killed).
 *
 * Then its value, rules in this order: a kill switch serves the default, overriding every rule;
 * a stored rule this code does not know serves the default; then the plan, the workspace and the
 * percentage rollout (a hash of the flag key and the `usr_` id, `bucket.ts`) must all pass for the
 * flag's value, else the default.
 *
 * `isEnabled` evaluates one flag for server code, `server_only` ones included: true only when it
 * is a boolean flag whose value is true for the context.
 *
 * Owns: the order of the rules. Must not: read anything but its arguments (no clock, no I/O).
 */
import { inRollout } from './bucket.js';
import type { EvalFlag, FlagValue, Plan } from './definition.js';
import { compareSemver, parseSemver, type Semver } from './version.js';

/** Who is asking. */
export interface EvalContext {
  /** The caller's `usr_` id; absent for anonymous callers and machine principals. */
  userId?: string;
  /** The caller's active workspace (`wsp_`). */
  workspaceId?: string;
  plan?: Plan;
  /** The client's version (`1.4.2`), from its User-Agent; absent when unknown. */
  clientVersion?: string;
  now: Date;
}

/** Flags by key, as a client receives them. */
export type FlagSet = Record<string, FlagValue>;

/** True when the flag's answer depends on who the caller is. */
const perCaller = (flag: EvalFlag): boolean =>
  flag.basisPoints !== null || flag.plans !== null || flag.workspaces !== null;

function versionFits(flag: EvalFlag, version: Semver | null): boolean {
  if (flag.version === null) return true;
  if (version === null) return false;
  const { min, max } = flag.version;
  return (
    (min === null || compareSemver(version, min) >= 0) &&
    (max === null || compareSemver(version, max) <= 0)
  );
}

/** The flag's value for `ctx`, rules only (whether it is shown is decided before). */
function valueOf(flag: EvalFlag, ctx: EvalContext, version: Semver | null): FlagValue {
  if (flag.kill || flag.broken) return flag.default;
  if (!versionFits(flag, version)) return flag.default;
  if (flag.plans !== null && (ctx.plan === undefined || !flag.plans.has(ctx.plan))) {
    return flag.default;
  }
  if (
    flag.workspaces !== null &&
    (ctx.workspaceId === undefined || !flag.workspaces.has(ctx.workspaceId))
  ) {
    return flag.default;
  }
  if (flag.basisPoints !== null) {
    if (ctx.userId === undefined || !inRollout(flag.key, ctx.userId, flag.basisPoints)) {
      return flag.default;
    }
  }
  return flag.value;
}

/** Whether a client in `ctx` is shown the flag at all. */
function shown(flag: EvalFlag, ctx: EvalContext, version: Semver | null): boolean {
  if (flag.serverOnly) return false;
  if (ctx.userId === undefined && (!flag.public || perCaller(flag))) return false;
  return flag.kill || versionFits(flag, version);
}

/** The flags a client in `ctx` receives, by key in code-point order. */
export function evaluateFlags(ctx: EvalContext, defs: readonly EvalFlag[]): FlagSet {
  const version = ctx.clientVersion === undefined ? null : parseSemver(ctx.clientVersion);
  const visible = defs
    .filter((flag) => shown(flag, ctx, version))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // fromEntries defines own properties: a key such as `__proto__` stays an ordinary key.
  return Object.fromEntries(visible.map((flag) => [flag.key, valueOf(flag, ctx, version)]));
}

/** For server code: true when the boolean flag `key` is on for `ctx` (false when unknown). */
export function isEnabledIn(
  defs: ReadonlyMap<string, EvalFlag>,
  key: string,
  ctx: EvalContext,
): boolean {
  const flag = defs.get(key);
  if (flag === undefined) return false;
  const version = ctx.clientVersion === undefined ? null : parseSemver(ctx.clientVersion);
  return valueOf(flag, ctx, version) === true;
}
