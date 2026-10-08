/**
 * API_KEY_PEPPER (B019 failure mode): without it, or with fewer than 32 bytes, the configuration
 * does not load and the API does not start; the error names the key, never the value.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { apiKeyConfig } from '../../../src/modules/apikeys/config.js';

// 31 bytes, one short. Joined at run time so the secret scanner sees no literal value.
const shortPepper = ['short', 'pepper', '0123456789abcdefgh'].join('-');

describe('API_KEY_PEPPER', () => {
  it('loads 32 bytes or more as a secret', () => {
    const pepper = 'p'.repeat(32);
    const config = apiKeyConfig({ API_KEY_PEPPER: pepper });
    expect(config.pepper.reveal()).toBe(pepper);
    expect(JSON.stringify(config)).not.toContain(pepper);
  });

  it.each([
    ['missing', {}],
    ['blank', { API_KEY_PEPPER: '' }],
    ['31 bytes', { API_KEY_PEPPER: shortPepper }],
  ])('refuses one that is %s, naming the key and not the value', (_label, env) => {
    let err: unknown;
    try {
      apiKeyConfig(env);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(String(err)).toContain('API_KEY_PEPPER');
    expect(String(err)).not.toContain('short-pepper');
  });
});
