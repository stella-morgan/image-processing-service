import type dns from 'node:dns';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/errors.js';
import { createSafeLookup, hostMatches, isBlockedAddress, SourceFetcher } from '../../src/lib/fetcher.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '::',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '151.101.1.69', '2606:4700::1111', 'example.com'])('allows %s', (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  );
});

type FakeAddresses = dns.LookupAddress[];

function fakeResolver(table: Record<string, FakeAddresses>) {
  return (
    hostname: string,
    _options: dns.LookupAllOptions,
    cb: (err: NodeJS.ErrnoException | null, addresses: FakeAddresses) => void,
  ) => {
    const entry = table[hostname];
    if (!entry) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }), []);
    cb(null, entry);
  };
}

function lookupOnce(lookup: ReturnType<typeof createSafeLookup>, host: string, all = false) {
  return new Promise<{ err: (Error & { code?: string }) | null; address: unknown }>((resolve) => {
    lookup(host, { all }, (err, address) => resolve({ err, address }));
  });
}

describe('createSafeLookup', () => {
  const lookup = createSafeLookup(
    fakeResolver({
      'public.test': [{ address: '93.184.216.34', family: 4 }],
      'private.test': [{ address: '10.0.0.7', family: 4 }],
      'mixed.test': [
        { address: '127.0.0.1', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ],
      'rebind.test': [{ address: '::ffff:169.254.169.254', family: 6 }],
    }),
  );

  it('passes public addresses through', async () => {
    expect(await lookupOnce(lookup, 'public.test')).toEqual({ err: null, address: '93.184.216.34' });
  });

  it('refuses hostnames that only resolve to private addresses', async () => {
    for (const host of ['private.test', 'rebind.test']) {
      const { err } = await lookupOnce(lookup, host);
      expect(err?.code).toBe('EBLOCKED');
    }
  });

  it('drops private addresses from mixed answers', async () => {
    expect((await lookupOnce(lookup, 'mixed.test')).address).toBe('93.184.216.34');
    expect((await lookupOnce(lookup, 'mixed.test', true)).address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('propagates resolver errors', async () => {
    expect((await lookupOnce(lookup, 'missing.test')).err?.code).toBe('ENOTFOUND');
  });
});

describe('SourceFetcher DNS guard', () => {
  it('maps a hostname resolving to a private IP to FORBIDDEN_URL', async () => {
    const fetcher = new SourceFetcher({
      maxBytes: 1024,
      timeoutMs: 2000,
      allowPrivateNetworks: false,
      resolve: fakeResolver({ 'internal.test': [{ address: '10.0.0.7', family: 4 }] }),
    });
    const err = await fetcher.fetch(new URL('http://internal.test/a.jpg')).catch((e: unknown) => e);
    await fetcher.close();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('FORBIDDEN_URL');
  });
});

describe('hostMatches', () => {
  const patterns = ['images.example.com', '*.cdn.example.com'];

  it.each([
    ['images.example.com', true],
    ['IMAGES.example.com.', true],
    ['a.cdn.example.com', true],
    ['a.b.cdn.example.com', true],
    ['cdn.example.com', false],
    ['evilcdn.example.com', false],
    ['images.example.com.evil.test', false],
  ])('%s -> %s', (host, expected) => {
    expect(hostMatches(host, patterns)).toBe(expected);
  });
});
