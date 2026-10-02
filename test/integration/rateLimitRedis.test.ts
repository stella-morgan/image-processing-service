import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { type FixtureServer, startFixtureServer } from '../helpers/fixtureServer.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;

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
    config: { allowPrivateNetworks: true, rateLimitMax: 1, rateLimitWindowMs: 60_000, ...config },
  });
  apps.push(app);
  return app;
}

const call = (app: FastifyInstance, ip: string) =>
  app.inject({ method: 'GET', url: '/info', query: { url: `${fixtures.baseUrl}/photo.jpg` }, remoteAddress: ip });

const uniqueIp = () => `198.18.${randomInt(256)}.${randomInt(1, 255)}`;

describe('Redis store unavailable', () => {
  it('fails open: requests are served and /health reports the store as disconnected', async () => {
    const app = await appWith({ redisUrl: 'redis://127.0.0.1:1' });
    const ip = uniqueIp();
    for (let i = 0; i < 3; i++) expect((await call(app, ip)).statusCode).toBe(200);

    const health = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(health.rateLimit).toEqual({ enabled: true, store: 'redis', connected: false });
  });
});

describe.skipIf(!TEST_REDIS_URL)('Redis store', () => {
  it('shares one limit across instances', async () => {
    const [a, b] = await Promise.all([appWith({ redisUrl: TEST_REDIS_URL }), appWith({ redisUrl: TEST_REDIS_URL })]);
    await new Promise((r) => setTimeout(r, 200));
    expect((await a.inject({ method: 'GET', url: '/health' })).json().rateLimit.connected).toBe(true);

    const ip = uniqueIp();
    expect((await call(a, ip)).statusCode).toBe(200);
    const limited = await call(b, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });
});
