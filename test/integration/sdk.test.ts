import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createClient, ImageServiceError } from '../../src/sdk/index.js';
import { createSigner } from '../../src/sdk/signer.js';
import { type FixtureServer, send, startFixtureServer } from '../helpers/fixtureServer.js';
import { makeVideo } from '../helpers/video.js';

const SECRET = 'sdk-test-secret-0123456';

let fixtures: FixtureServer;
let app: FastifyInstance;
let signedApp: FastifyInstance;
let baseUrl: string;
let signedBaseUrl: string;

beforeAll(async () => {
  const video = await makeVideo();
  fixtures = await startFixtureServer({ '/video.mp4': (res) => send(res, 200, 'video/mp4', video) });
  app = await buildApp({ logger: false, config: { allowPrivateNetworks: true } });
  signedApp = await buildApp({ logger: false, config: { allowPrivateNetworks: true, signingSecret: SECRET } });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  signedBaseUrl = await signedApp.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await Promise.all([app.close(), signedApp.close()]);
  await fixtures.close();
});

describe('SDK', () => {
  it('builds URLs without making requests', () => {
    const client = createClient({ baseUrl: 'https://img.example.com/' });
    const url = new URL(
      client.url('https://cdn.example.com/a b.jpg', { width: 500, format: 'webp', quality: undefined }),
    );
    expect(url.origin + url.pathname).toBe('https://img.example.com/process');
    expect(url.searchParams.get('url')).toBe('https://cdn.example.com/a b.jpg');
    expect(url.searchParams.get('width')).toBe('500');
    expect(url.searchParams.has('quality')).toBe(false);
    expect(url.searchParams.has('signature')).toBe(false);

    const thumb = new URL(client.thumbnailUrl('https://cdn.example.com/v.mp4', { time: 15 }));
    expect(thumb.pathname).toBe('/video/thumbnail');
    expect(thumb.searchParams.get('time')).toBe('15');
  });

  it('fetches a transformed image', async () => {
    const client = createClient({ baseUrl });
    const img = await client.fetch(`${fixtures.baseUrl}/photo.jpg`, {
      width: 100,
      height: 100,
      crop: 'fill',
      format: 'png',
    });
    expect(img.contentType).toBe('image/png');
    expect([img.width, img.height]).toEqual([100, 100]);
    expect(img.data.byteLength).toBeGreaterThan(0);
  });

  it('fetches thumbnails and info', async () => {
    const client = createClient({ baseUrl });
    const thumb = await client.thumbnail(`${fixtures.baseUrl}/video.mp4`, { time: 1, width: 64 });
    expect(thumb.width).toBe(64);
    const info = await client.info(`${fixtures.baseUrl}/photo.jpg`);
    expect(info).toMatchObject({ format: 'jpeg', width: 800, height: 600 });
  });

  it('throws typed errors carrying the API error code', async () => {
    const client = createClient({ baseUrl });
    const err = await client.fetch(`${fixtures.baseUrl}/photo.jpg`, { width: -1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageServiceError);
    expect(err).toMatchObject({ status: 400, code: 'INVALID_PARAMETER' });
    expect((err as ImageServiceError).details[0]?.field).toBe('width');
  });

  describe('with a signer', () => {
    it('signs every request so a signing-enabled server accepts it', async () => {
      const client = createClient({ baseUrl: signedBaseUrl, signer: createSigner(SECRET) });
      expect((await client.fetch(`${fixtures.baseUrl}/photo.jpg`, { width: 50 })).width).toBe(50);
      expect((await client.thumbnail(`${fixtures.baseUrl}/video.mp4`, { width: 32 })).width).toBe(32);
      expect((await client.info(`${fixtures.baseUrl}/photo.jpg`)).width).toBe(800);

      const res = await fetch(client.url(`${fixtures.baseUrl}/photo.jpg`, { width: 10 }));
      expect(res.status).toBe(200);
    });

    it('surfaces INVALID_SIGNATURE when the secret is wrong', async () => {
      const client = createClient({ baseUrl: signedBaseUrl, signer: createSigner('wrong-secret-0123456789') });
      const err = await client.fetch(`${fixtures.baseUrl}/photo.jpg`).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 403, code: 'INVALID_SIGNATURE' });
    });
  });
});
