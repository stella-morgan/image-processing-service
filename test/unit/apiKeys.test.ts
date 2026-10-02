import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ApiKeyRegistry, parseApiKeys, redactSecrets } from '../../src/lib/apiKeys.js';

const KEY_A = 'sk_live_aaaaaaaaaaaaaaaa';
const KEY_B = 'sk_live_bbbbbbbbbbbbbbbb';

describe('parseApiKeys', () => {
  it('parses name:key and name:key:limit entries', () => {
    expect(parseApiKeys(` partner:${KEY_A}:1000 , internal:${KEY_B} ,`)).toEqual([
      { name: 'partner', key: KEY_A, limit: 1000 },
      { name: 'internal', key: KEY_B, limit: undefined },
    ]);
  });

  it('returns an empty list for an empty string', () => {
    expect(parseApiKeys('')).toEqual([]);
  });

  it.each([
    ['missing key', 'partner', /name:key/],
    ['too many parts', `partner:${KEY_A}:10:extra`, /name:key/],
    ['bad name', `has space:${KEY_A}`, /alphanumeric/],
    ['short key', 'partner:short', /16-256/],
    ['bad limit', `partner:${KEY_A}:0`, /positive integer/],
    ['non-numeric limit', `partner:${KEY_A}:lots`, /positive integer/],
    ['duplicate name', `partner:${KEY_A},partner:${KEY_B}`, /more than once/],
    ['duplicate key', `a:${KEY_A},b:${KEY_A}`, /already assigned/],
  ])('rejects %s', (_name, raw, message) => {
    expect(() => parseApiKeys(raw)).toThrow(message);
  });

  it('never echoes a full key in error messages', () => {
    expect(() => parseApiKeys(`${KEY_A}${KEY_A}`)).toThrow(/^entry "sk_live_aaaaaaaaaaaa…"/);
  });
});

describe('ApiKeyRegistry', () => {
  const registry = new ApiKeyRegistry(parseApiKeys(`partner:${KEY_A}:1000,internal:${KEY_B}`));

  it('resolves known keys to their client', () => {
    expect(registry.lookup(KEY_A)).toEqual({ name: 'partner', limit: 1000 });
    expect(registry.lookup(KEY_B)).toEqual({ name: 'internal', limit: undefined });
  });

  it('returns undefined for unknown keys, including prefixes of real ones', () => {
    expect(registry.lookup('sk_live_unknown_key_123')).toBeUndefined();
    expect(registry.lookup(KEY_A.slice(0, -1))).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  it('masks api_key and signature in URLs', () => {
    expect(redactSecrets(`/process?url=x&api_key=${KEY_A}&width=5&signature=abc`)).toBe(
      '/process?url=x&api_key=[redacted]&width=5&signature=[redacted]',
    );
    expect(redactSecrets(`/info?API_KEY=${KEY_A}`)).toBe('/info?API_KEY=[redacted]');
    expect(redactSecrets('/process?url=x&width=5')).toBe('/process?url=x&width=5');
  });
});

describe('loadConfig rate limiting', () => {
  it('uses defaults', () => {
    expect(loadConfig({})).toMatchObject({
      rateLimitMax: 60,
      rateLimitWindowMs: 60_000,
      apiKeys: [],
      requireApiKey: false,
      trustProxy: false,
      redisUrl: undefined,
    });
  });

  it('parses env values', () => {
    const c = loadConfig({
      RATE_LIMIT_MAX: '10',
      RATE_LIMIT_WINDOW_MS: '1000',
      API_KEYS: `partner:${KEY_A}:100`,
      REQUIRE_API_KEY: 'true',
      TRUST_PROXY: 'true',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(c).toMatchObject({
      rateLimitMax: 10,
      rateLimitWindowMs: 1000,
      apiKeys: [{ name: 'partner', key: KEY_A, limit: 100 }],
      requireApiKey: true,
      trustProxy: true,
      redisUrl: 'redis://localhost:6379',
    });
  });

  it('reports invalid API_KEYS, REDIS_URL and REQUIRE_API_KEY without keys', () => {
    expect(() => loadConfig({ API_KEYS: 'partner:short' })).toThrow(/API_KEYS: key for "partner"/);
    expect(() => loadConfig({ REDIS_URL: 'http://localhost' })).toThrow(/REDIS_URL: must start with redis/);
    expect(() => loadConfig({ REQUIRE_API_KEY: 'true' })).toThrow(/REQUIRE_API_KEY: requires at least one/);
  });
});
