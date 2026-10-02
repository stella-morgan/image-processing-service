import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { type FixtureServer, send, startFixtureServer } from '../helpers/fixtureServer.js';
import { makeVideo, maliciousPlaylist } from '../helpers/video.js';

let fixtures: FixtureServer;
let app: FastifyInstance;
let secretDir: string;

beforeAll(async () => {
  const [mp4, webm] = await Promise.all([makeVideo('mp4'), makeVideo('webm')]);

  secretDir = await mkdtemp(path.join(tmpdir(), 'secret-'));
  const secretFile = path.join(secretDir, 'secret.mp4');
  await writeFile(secretFile, mp4);

  fixtures = await startFixtureServer({
    '/video.mp4': (res) => send(res, 200, 'video/mp4', mp4),
    '/video.webm': (res) => send(res, 200, 'video/webm', webm),
    '/playlist-local.mp4': (res) => send(res, 200, 'video/mp4', maliciousPlaylist(`file://${secretFile}`)),
    '/playlist-remote.mp4': (res) =>
      send(res, 200, 'video/mp4', maliciousPlaylist('http://169.254.169.254/latest/meta-data')),
  });
  app = await buildApp({ logger: false, config: { allowPrivateNetworks: true } });
});

afterAll(async () => {
  await app.close();
  await fixtures.close();
  await rm(secretDir, { recursive: true, force: true });
});

const get = (query: Record<string, string>) => app.inject({ method: 'GET', url: '/video/thumbnail', query });
const src = (p: string) => `${fixtures.baseUrl}${p}`;

describe('GET /video/thumbnail', () => {
  it('extracts a JPEG frame by default', async () => {
    const res = await get({ url: src('/video.mp4'), time: '1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    const m = await sharp(res.rawPayload).metadata();
    expect([m.width, m.height]).toEqual([320, 240]);
  });

  it('supports WebM sources', async () => {
    const res = await get({ url: src('/video.webm'), time: '0.5', format: 'png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('applies image transforms to the frame', async () => {
    const res = await get({
      url: src('/video.mp4'),
      time: '0.5',
      width: '160',
      height: '160',
      crop: 'fill',
      format: 'webp',
    });
    expect(res.headers['content-type']).toBe('image/webp');
    const m = await sharp(res.rawPayload).metadata();
    expect([m.width, m.height]).toEqual([160, 160]);
  });

  it('different timestamps produce different frames', async () => {
    const a = await get({ url: src('/video.mp4'), time: '0', format: 'png' });
    const b = await get({ url: src('/video.mp4'), time: '2', format: 'png' });
    expect(a.headers.etag).not.toBe(b.headers.etag);
  });

  it('time beyond the duration -> 400 with a helpful message', async () => {
    const res = await get({ url: src('/video.mp4'), time: '15' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0]).toMatchObject({ field: 'time', message: expect.stringContaining('duration') });
  });

  it('non-video source -> 415', async () => {
    const res = await get({ url: src('/page.html') });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('missing url -> 400', async () => {
    expect((await get({ time: '1' })).statusCode).toBe(400);
  });

  describe('security: playlists disguised as videos', () => {
    it.each(['/playlist-local.mp4', '/playlist-remote.mp4'])('%s is rejected before ffmpeg runs', async (p) => {
      const res = await get({ url: src(p), time: '0.5' });
      expect(res.statusCode).toBe(415);
      expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });
  });
});
