/**
 * OAuth scopes (B021, CT-AUTH): the scopes access tokens and API keys carry, and the checks
 * endpoints make on them (`requireScope` in the API). A principal has a scope only by exact name;
 * there is no wildcard or implication (`workspaces:write` does not include `workspaces:read`).
 */

/** Every CT-AUTH scope. `admin` is internal: staff only, never from public flows. */
export const SCOPES = [
  'profile',
  'workspaces:read',
  'workspaces:write',
  'sessions:read',
  'sessions:write',
  'sessions:host',
  'billing:read',
  'billing:write',
  'usage:write',
  'webhooks:write',
  'audit:read',
  'admin',
] as const;

/** A CT-AUTH scope. */
export type Scope = (typeof SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

/** True for a CT-AUTH scope. */
export const isScope = (value: unknown): value is Scope =>
  typeof value === 'string' && SCOPE_SET.has(value);

/** Anything that carries scopes. */
export interface ScopeHolder {
  scopes: readonly string[];
}

const scopesOf = (principal: unknown): readonly unknown[] => {
  const scopes = (principal as { scopes?: unknown } | null | undefined)?.scopes;
  return Array.isArray(scopes) ? (scopes as unknown[]) : [];
};

/** True when `principal` holds `scope` (exact name; an unknown scope is never held). */
export function hasScope(principal: ScopeHolder | null | undefined, scope: Scope): boolean {
  return isScope(scope) && scopesOf(principal).includes(scope);
}

/** True when `principal` holds every scope of `required` (the empty list is always held). */
export function hasScopes(
  principal: ScopeHolder | null | undefined,
  required: readonly Scope[],
): boolean {
  return required.every((scope) => hasScope(principal, scope));
}
