import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { createClient, ImageServiceError } from '../../src/sdk/index.js';
import { createSigner } from '../../src/sdk/signer.js';
import { type FixtureServer, startFixtureServer } from '../helpers/fixtureServer.js';

const KEY = 'sk_sdk_test_0123456789abcdef';
const SECRET = 'sdk-rate-limit-secret-01';

let fixtures: FixtureServer;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await fixtures.close();
});

async function serve(config: Partial<Config>) {
  const app = await buildApp({
    logger: false,
    config: {
      allowPrivateNetworks: true,
      rateLimitMax: 100,
      apiKeys: [{ name: 'sdk', key: KEY }],
      requireApiKey: true,
      ...config,
    },
  });
  apps.push(app);
  return app.listen({ port: 0, host: '127.0.0.1' });
}

function countingFetch() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return fetch(input, init);
  };
  return { calls, impl };
}

const photo = () => `${fixtures.baseUrl}/photo.jpg`;

describe('SDK with API keys', () => {
  it('sends the key as a header on requests and keeps it out of the URL', async () => {
    const baseUrl = await serve({});
    const { calls, impl } = countingFetch();
    const client = createClient({ baseUrl, apiKey: KEY, fetch: impl });

    expect((await client.fetch(photo(), { width: 10 })).width).toBe(10);
    expect((await client.info(photo())).width).toBe(800);
    for (const c of calls) {
      expect(c.headers['x-api-key']).toBe(KEY);
      expect(c.url).not.toContain('api_key');
    }
  });

  it('puts the key in URLs built for <img> tags, and signs it', async () => {
    const baseUrl = await serve({ signingSecret: SECRET });
    const client = createClient({ baseUrl, apiKey: KEY, signer: createSigner(SECRET) });
    const url = client.url(photo(), { width: 12 });
    expect(new URL(url).searchParams.get('api_key')).toBe(KEY);
    expect((await fetch(url)).status).toBe(200);
  });

  it('surfaces INVALID_API_KEY when the key is wrong', async () => {
    const baseUrl = await serve({});
    const err = await createClient({ baseUrl, apiKey: 'sk_wrong_0123456789abcdef' })
      .info(photo())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, code: 'INVALID_API_KEY' });
  });
});

describe('SDK retries', () => {
  it('exposes retryAfter on 429 errors', async () => {
    const baseUrl = await serve({ rateLimitMax: 1 });
    const client = createClient({ baseUrl, apiKey: KEY });
    await client.info(photo());
    const err = await client.info(photo()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageServiceError);
    expect(err).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect((err as ImageServiceError).retryAfter).toBeGreaterThan(0);
  });

  it('waits for Retry-After and retries rate-limited requests when enabled', async () => {
    const baseUrl = await serve({ rateLimitMax: 1, rateLimitWindowMs: 1000 });
    const { calls, impl } = countingFetch();
    const client = createClient({ baseUrl, apiKey: KEY, fetch: impl, retry: { attempts: 2 } });

    await client.info(photo());
    const started = Date.now();
    expect((await client.info(photo())).width).toBe(800);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(calls).toHaveLength(3);
  });

  it('caps the wait at maxDelayMs and gives up after the configured attempts', async () => {
    const baseUrl = await serve({ rateLimitMax: 1, rateLimitWindowMs: 60_000 });
    const { calls, impl } = countingFetch();
    const client = createClient({ baseUrl, apiKey: KEY, fetch: impl, retry: { attempts: 2, maxDelayMs: 10 } });

    await client.info(photo());
    const err = await client.info(photo()).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429 });
    expect(calls).toHaveLength(4);
  });

  it('never retries validation errors', async () => {
    const baseUrl = await serve({});
    const { calls, impl } = countingFetch();
    const client = createClient({ baseUrl, apiKey: KEY, fetch: impl, retry: { attempts: 3 } });
    const err = await client.fetch(photo(), { width: -1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
  });
});
