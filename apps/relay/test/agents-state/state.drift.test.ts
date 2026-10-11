/**
 * B058 drift guard (acceptance 4; `pnpm test` runs it in CI): the `state` enum of `p_agent_state` in
 * `contracts/schemas/events.schema.json` equals the key set of `contracts/state-map.json`, and the
 * generated `PRODUCT_STATES` equals both.
 */
import { readFileSync } from 'node:fs';
import { PRODUCT_STATES } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';

const contract = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../../contracts/${name}`, import.meta.url), 'utf8'));

describe('state-map drift (acceptance 4)', () => {
  it('p_agent_state.state enum = state-map.json keys = PRODUCT_STATES', () => {
    const keys = Object.keys(contract('state-map.json') as Record<string, string>).sort();
    const schema = contract('schemas/events.schema.json') as {
      $defs: { p_agent_state: { properties: { state: { enum: string[] } } } };
    };
    const enumValues = [...schema.$defs.p_agent_state.properties.state.enum].sort();
    expect(enumValues).toEqual(keys);
    expect([...PRODUCT_STATES].sort()).toEqual(keys);
  });
});
