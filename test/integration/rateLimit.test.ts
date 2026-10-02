import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { sign } from '../../src/lib/signing.js';
import { type FixtureServer, startFixtureServer } from '../helpers/fixtureServer.js';

const PARTNER = 'sk_partner_0123456789abcdef';
const INTERNAL = 'sk_internal_0123456789abcdef';
const API_KEYS = [
  { name: 'partner', key: PARTNER, limit: 5 },
  { name: 'internal', key: INTERNAL },
];

let fixtures: FixtureServer;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await fixtures.close();
});

async function appWith(config: Partial<Config>) {
  const app = await buildApp({
    logger: false,
    config: { allowPrivateNetworks: true, rateLimitMax: 2, rateLimitWindowMs: 60_000, apiKeys: API_KEYS, ...config },
  });
  apps.push(app);
  return app;
}

interface Call {
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  ip?: string;
}

function call(app: FastifyInstance, { path = '/info', query, headers, ip = '203.0.113.10' }: Call = {}) {
  return app.inject({
    method: 'GET',
    url: path,
    query: query ?? { url: `${fixtures.baseUrl}/photo.jpg` },
    headers,
    remoteAddress: ip,
  });
}

describe('rate limiting', () => {
  it('sends RateLimit headers that count down', async () => {
    const app = await appWith({});
    const first = await call(app);
    expect(first.statusCode).toBe(200);
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    expect(Number(first.headers['ratelimit-reset'])).toBeGreaterThan(0);
    expect((await call(app)).headers['ratelimit-remaining']).toBe('0');
  });

  it('returns 429 in the standard error envelope once the limit is used up', async () => {
    const app = await appWith({});
    await call(app);
    await call(app);
    const limited = await call(app);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('2 requests'),
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['cache-control']).toBe('no-store');
  });

  it('resets after the window', async () => {
    const app = await appWith({ rateLimitMax: 1, rateLimitWindowMs: 300 });
    expect((await call(app)).statusCode).toBe(200);
    expect((await call(app)).statusCode).toBe(429);
    await new Promise((r) => setTimeout(r, 400));
    expect((await call(app)).statusCode).toBe(200);
  });

  it('applies to every protected route but never to /health, /docs, / or unknown routes', async () => {
    const app = await appWith({ rateLimitMax: 1 });
    expect((await call(app, { path: '/process', query: { url: `${fixtures.baseUrl}/photo.jpg` } })).statusCode).toBe(
      200,
    );
    expect((await call(app, { path: '/video/thumbnail', query: { url: 'https://x.test/v.mp4' } })).statusCode).toBe(
      429,
    );
    for (const path of ['/health', '/docs/json', '/', '/nope']) {
      const res = await call(app, { path, query: {} });
      expect(res.statusCode, path).not.toBe(429);
      expect(res.headers['ratelimit-limit'], path).toBeUndefined();
    }
  });

  it('limits anonymous clients per IP', async () => {
    const app = await appWith({ rateLimitMax: 1 });
    expect((await call(app, { ip: '198.51.100.1' })).statusCode).toBe(200);
    expect((await call(app, { ip: '198.51.100.1' })).statusCode).toBe(429);
    expect((await call(app, { ip: '198.51.100.2' })).statusCode).toBe(200);
  });

  it('groups IPv6 clients by /64 so rotating addresses does not bypass the limit', async () => {
    const app = await appWith({ rateLimitMax: 1 });
    expect((await call(app, { ip: '2001:db8:1:2::1' })).statusCode).toBe(200);
    expect((await call(app, { ip: '2001:db8:1:2::ffff' })).statusCode).toBe(429);
  });

  it('reports its state on /health', async () => {
    expect((await call(await appWith({}), { path: '/health', query: {} })).json().rateLimit).toEqual({
      enabled: true,
      store: 'memory',
      connected: true,
    });
    const disabled = await appWith({ rateLimitMax: 0 });
    expect((await call(disabled, { path: '/health', query: {} })).json().rateLimit.enabled).toBe(false);
    expect((await call(disabled)).headers['ratelimit-limit']).toBeUndefined();
  });
});

describe('API keys', () => {
  it('gives each key its own bucket and limit, separate from anonymous traffic', async () => {
    const app = await appWith({});
    const partner = await call(app, { headers: { 'x-api-key': PARTNER } });
    expect(partner.headers['ratelimit-limit']).toBe('5');
    expect(partner.headers['ratelimit-remaining']).toBe('4');

    const internal = await call(app, { headers: { 'x-api-key': INTERNAL } });
    expect(internal.headers['ratelimit-limit']).toBe('2');
    expect(internal.headers['ratelimit-remaining']).toBe('1');

    expect((await call(app)).headers['ratelimit-remaining']).toBe('1');
  });

  it('follows the key across IPs and counts header and query use against the same bucket', async () => {
    const app = await appWith({});
    const viaHeader = await call(app, { headers: { 'x-api-key': INTERNAL }, ip: '198.51.100.1' });
    const viaQuery = await call(app, {
      query: { url: `${fixtures.baseUrl}/photo.jpg`, api_key: INTERNAL },
      ip: '198.51.100.2',
    });
    expect(viaHeader.headers['ratelimit-remaining']).toBe('1');
    expect(viaQuery.headers['ratelimit-remaining']).toBe('0');
    expect((await call(app, { headers: { 'x-api-key': INTERNAL }, ip: '198.51.100.3' })).statusCode).toBe(429);
  });

  it('rejects unknown keys with 401 without consuming the limit', async () => {
    const app = await appWith({});
    const res = await call(app, { headers: { 'x-api-key': 'sk_unknown_0123456789abcdef' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_API_KEY');
    expect((await call(app)).headers['ratelimit-remaining']).toBe('1');
  });

  it('rejects conflicting or repeated keys', async () => {
    const app = await appWith({});
    const conflict = await call(app, {
      headers: { 'x-api-key': PARTNER },
      query: { url: `${fixtures.baseUrl}/photo.jpg`, api_key: INTERNAL },
    });
    expect(conflict.statusCode).toBe(400);
    expect(conflict.json().error.details[0].field).toBe('api_key');

    const repeated = await app.inject({
      method: 'GET',
      url: `/info?url=${encodeURIComponent(`${fixtures.baseUrl}/photo.jpg`)}&api_key=${PARTNER}&api_key=${INTERNAL}`,
    });
    expect(repeated.statusCode).toBe(400);
  });

  it('REQUIRE_API_KEY turns anonymous access off for protected routes only', async () => {
    const app = await appWith({ requireApiKey: true });
    const anonymous = await call(app);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.message).toMatch(/required/);
    expect((await call(app, { headers: { 'x-api-key': PARTNER } })).statusCode).toBe(200);
    expect((await call(app, { path: '/health', query: {} })).statusCode).toBe(200);
  });
});

describe('client IP behind a proxy', () => {
  const spoofed = (ip: string) => ({ headers: { 'x-forwarded-for': ip }, ip: '10.0.0.1' });

  it('uses X-Forwarded-For when TRUST_PROXY is on', async () => {
    const app = await appWith({ rateLimitMax: 1, trustProxy: true });
    expect((await call(app, spoofed('198.51.100.1'))).statusCode).toBe(200);
    expect((await call(app, spoofed('198.51.100.2'))).statusCode).toBe(200);
    expect((await call(app, spoofed('198.51.100.1'))).statusCode).toBe(429);
  });

  it('ignores X-Forwarded-For when TRUST_PROXY is off, so it cannot be used to dodge the limit', async () => {
    const app = await appWith({ rateLimitMax: 1 });
    expect((await call(app, spoofed('198.51.100.1'))).statusCode).toBe(200);
    expect((await call(app, spoofed('198.51.100.2'))).statusCode).toBe(429);
  });
});

describe('with signed URLs', () => {
  const secret = 'rate-limit-secret-0123';
  const query = () => ({ url: `${fixtures.baseUrl}/photo.jpg`, api_key: PARTNER });

  it('includes api_key in the signature', async () => {
    const app = await appWith({ signingSecret: secret });
    const q = query();
    expect((await call(app, { query: { ...q, signature: sign(secret, '/info', q) } })).statusCode).toBe(200);
    const withoutKey = sign(secret, '/info', { url: q.url });
    expect((await call(app, { query: { ...q, signature: withoutKey } })).statusCode).toBe(403);
  });

  it('rate limits signature guessing', async () => {
    const app = await appWith({ signingSecret: secret });
    const bad = { query: { url: `${fixtures.baseUrl}/photo.jpg`, signature: 'guess' } };
    expect((await call(app, bad)).statusCode).toBe(403);
    expect((await call(app, bad)).statusCode).toBe(403);
    expect((await call(app, bad)).statusCode).toBe(429);
  });
});
