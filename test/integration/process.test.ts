import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { sign } from '../../src/lib/signing.js';
import { type FixtureServer, startFixtureServer } from '../helpers/fixtureServer.js';

let fixtures: FixtureServer;
let app: FastifyInstance;
const extraApps: FastifyInstance[] = [];

async function appWith(config: Partial<Config>) {
  const instance = await buildApp({ logger: false, config: { allowPrivateNetworks: true, ...config } });
  extraApps.push(instance);
  return instance;
}

beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await buildApp({
    logger: false,
    config: { allowPrivateNetworks: true, maxImageBytes: 1024 * 1024, fetchTimeoutMs: 2000, cacheTtlSeconds: 60 },
  });
});

afterAll(async () => {
  await Promise.all([app, ...extraApps].map((a) => a.close()));
  await fixtures.close();
});

function get(path: string, query: Record<string, string> = {}, headers: Record<string, string> = {}, on = app) {
  return on.inject({ method: 'GET', url: path, query, headers });
}

const src = (p: string) => `${fixtures.baseUrl}${p}`;
const meta = (body: Buffer) => sharp(body).metadata();

describe('GET /process', () => {
  it('resizes to exact dimensions (crop=scale default)', async () => {
    const res = await get('/process', { url: src('/photo.jpg'), width: '500', height: '300' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    const m = await meta(res.rawPayload);
    expect([m.width, m.height]).toEqual([500, 300]);
    expect(res.headers['x-image-width']).toBe('500');
  });

  it('keeps aspect ratio when only width is given', async () => {
    const res = await get('/process', { url: src('/photo.jpg'), width: '400' });
    const m = await meta(res.rawPayload);
    expect([m.width, m.height]).toEqual([400, 300]);
  });

  it('converts format with quality', async () => {
    const res = await get('/process', { url: src('/alpha.png'), format: 'jpeg', quality: '80' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect((await meta(res.rawPayload)).format).toBe('jpeg');
  });

  it('flattens transparency onto the requested background when converting to jpeg', async () => {
    const res = await get('/process', { url: src('/alpha.png'), format: 'jpeg', background: '000000' });
    const { data } = await sharp(res.rawPayload).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(100);
    expect(data[1]).toBeLessThan(20);
  });

  it('combines resize, crop=fill and format conversion', async () => {
    const res = await get('/process', {
      url: src('/photo.jpg'),
      width: '800',
      height: '600',
      format: 'webp',
      crop: 'fill',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    const m = await meta(res.rawPayload);
    expect([m.format, m.width, m.height]).toEqual(['webp', 800, 600]);
  });

  it('crop=fill honours gravity', async () => {
    const res = await get('/process', {
      url: src('/photo.jpg'),
      width: '100',
      height: '100',
      crop: 'fill',
      gravity: 'north',
    });
    expect(res.statusCode).toBe(200);
  });

  it('crop=fit keeps aspect ratio inside the box', async () => {
    const res = await get('/process', { url: src('/photo.jpg'), width: '200', height: '200', crop: 'fit' });
    const m = await meta(res.rawPayload);
    expect([m.width, m.height]).toEqual([200, 150]);
  });

  it('crop=limit never upscales', async () => {
    const res = await get('/process', { url: src('/photo.jpg'), width: '2000', height: '2000', crop: 'limit' });
    const m = await meta(res.rawPayload);
    expect([m.width, m.height]).toEqual([800, 600]);
  });

  it('crop=pad produces the exact box with padding', async () => {
    const res = await get('/process', {
      url: src('/photo.jpg'),
      width: '300',
      height: '300',
      crop: 'pad',
      background: '00ff00',
      format: 'png',
    });
    const m = await meta(res.rawPayload);
    expect([m.width, m.height]).toEqual([300, 300]);
    const { data } = await sharp(res.rawPayload).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([0, 255, 0]);
  });

  it.each(['gif', 'tiff'])('encodes %s', async (format) => {
    const res = await get('/process', { url: src('/photo.jpg'), width: '20', format });
    expect(res.headers['content-type']).toBe(`image/${format}`);
    expect((await meta(res.rawPayload)).format).toBe(format);
  });

  it('keeps the source format when none is requested', async () => {
    const res = await get('/process', { url: src('/alpha.png'), width: '100' });
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('format=auto negotiates from the Accept header and sets Vary', async () => {
    const q = { url: src('/photo.jpg'), width: '50', format: 'auto' };
    const webp = await get('/process', q, { accept: 'image/webp,*/*' });
    expect(webp.headers['content-type']).toBe('image/webp');
    expect(webp.headers.vary).toBe('Accept');
    const avif = await get('/process', q, { accept: 'image/avif,image/webp' });
    expect(avif.headers['content-type']).toBe('image/avif');
    const basic = await get('/process', q, { accept: '*/*' });
    expect(basic.headers['content-type']).toBe('image/jpeg');
  });

  it('accepts short aliases', async () => {
    const res = await get('/process', { url: src('/photo.jpg'), w: '120', h: '80', f: 'png', c: 'fill' });
    const m = await meta(res.rawPayload);
    expect([m.format, m.width, m.height]).toEqual(['png', 120, 80]);
  });

  it('follows redirects', async () => {
    expect((await get('/process', { url: src('/redirect'), width: '10' })).statusCode).toBe(200);
  });

  it('decodes images served with a generic content type', async () => {
    expect((await get('/process', { url: src('/octet'), width: '10' })).statusCode).toBe(200);
  });

  it('includes a request id on every response', async () => {
    const res = await get('/process', { url: src('/photo.jpg'), width: '10' }, { 'x-request-id': 'abc-123' });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  describe('caching', () => {
    it('serves repeated requests from cache and supports conditional requests', async () => {
      const query = { url: src('/photo.jpg'), width: '77' };
      const first = await get('/process', query);
      const second = await get('/process', query);
      expect(first.headers['x-cache']).toBe('MISS');
      expect(second.headers['x-cache']).toBe('HIT');
      expect(second.headers.etag).toBe(first.headers.etag);
      expect(first.headers['cache-control']).toBe('public, max-age=60');

      const etag = String(first.headers.etag);
      for (const header of [etag, `W/${etag}`, `"other", ${etag}`]) {
        const notModified = await get('/process', query, { 'if-none-match': header });
        expect(notModified.statusCode).toBe(304);
        expect(notModified.rawPayload.length).toBe(0);
      }
    });

    it('coalesces identical concurrent requests into a single fetch', async () => {
      const query = { url: src('/delayed.jpg'), width: '33' };
      const responses = await Promise.all(Array.from({ length: 5 }, () => get('/process', query)));
      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      expect(fixtures.hits.get('/delayed.jpg')).toBe(1);
      expect(responses.map((r) => r.headers['x-cache']).sort()).toEqual([
        'COALESCED',
        'COALESCED',
        'COALESCED',
        'COALESCED',
        'MISS',
      ]);
    });

    it('marks errors as non-cacheable', async () => {
      const res = await get('/process', { url: src('/nope.jpg') });
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('errors', () => {
    const cases: [string, Record<string, string>, number, string][] = [
      ['missing url', {}, 400, 'INVALID_PARAMETER'],
      ['invalid width', { url: 'https://x.test/a.jpg', width: 'abc' }, 400, 'INVALID_PARAMETER'],
      ['oversized width', { url: 'https://x.test/a.jpg', width: '99999' }, 400, 'INVALID_PARAMETER'],
      ['unsupported format', { url: 'https://x.test/a.jpg', format: 'bmp' }, 400, 'INVALID_PARAMETER'],
      ['unknown parameter', { url: 'https://x.test/a.jpg', widht: '10' }, 400, 'INVALID_PARAMETER'],
      ['ineffective option', { url: 'https://x.test/a.jpg', width: '10', gravity: 'north' }, 400, 'INVALID_PARAMETER'],
      ['non-http url', { url: 'file:///etc/passwd' }, 400, 'INVALID_URL'],
    ];

    it.each(cases)('%s -> %i %s', async (_name, query, status, code) => {
      const res = await get('/process', query);
      expect(res.statusCode).toBe(status);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json().error.code).toBe(code);
    });

    it('404 from the source -> SOURCE_NOT_FOUND', async () => {
      const res = await get('/process', { url: src('/nope.jpg') });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('SOURCE_NOT_FOUND');
    });

    it('5xx from the source -> 502 SOURCE_FETCH_FAILED', async () => {
      const res = await get('/process', { url: src('/server-error') });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatchObject({ code: 'SOURCE_FETCH_FAILED', message: expect.stringContaining('500') });
    });

    it('non-image content -> 415', async () => {
      const res = await get('/process', { url: src('/page.html') });
      expect(res.statusCode).toBe(415);
      expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('corrupt image -> 422', async () => {
      const res = await get('/process', { url: src('/corrupt.jpg') });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('UNPROCESSABLE_SOURCE');
    });

    it('empty body -> 422', async () => {
      expect((await get('/process', { url: src('/empty.jpg') })).statusCode).toBe(422);
    });

    it('source larger than the limit -> 413', async () => {
      const res = await get('/process', { url: src('/huge') });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('SOURCE_TOO_LARGE');
    });

    it('source that never responds -> 504', async () => {
      const fast = await appWith({ fetchTimeoutMs: 200 });
      const res = await get('/process', { url: src('/hang') }, {}, fast);
      expect(res.statusCode).toBe(504);
      expect(res.json().error.code).toBe('SOURCE_TIMEOUT');
    });

    it('redirect loop -> 502', async () => {
      const res = await get('/process', { url: src('/redirect-loop') });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.message).toMatch(/redirects/i);
    });

    it('unresolvable host -> 502', async () => {
      expect((await get('/process', { url: 'http://does-not-exist.invalid/a.jpg' })).statusCode).toBe(502);
    });

    it('at capacity -> 503 with Retry-After', async () => {
      const busy = await appWith({ maxConcurrentJobs: 1, maxQueuedJobs: 0 });
      const first = get('/process', { url: src('/delayed.jpg'), width: '41' }, {}, busy);
      while (busy.services.limiter.stats.active === 0) await new Promise((r) => setImmediate(r));

      const rejected = await get('/process', { url: src('/photo.jpg'), width: '42' }, {}, busy);
      expect(rejected.statusCode).toBe(503);
      expect(rejected.headers['retry-after']).toBe('1');
      expect(rejected.json().error.code).toBe('SERVER_BUSY');
      expect((await first).statusCode).toBe(200);
    });
  });
});

describe('source restrictions', () => {
  describe('SSRF protection (default config)', () => {
    let secure: FastifyInstance;
    beforeAll(async () => {
      secure = await appWith({ allowPrivateNetworks: false });
    });

    it.each([
      'http://127.0.0.1/a.jpg',
      'http://localhost/a.jpg',
      'http://img.localhost/a.jpg',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/a.jpg',
      'http://[::ffff:127.0.0.1]/a.jpg',
      'http://10.0.0.5/a.jpg',
      'http://2130706433/a.jpg',
    ])('blocks %s', async (url) => {
      const res = await get('/process', { url }, {}, secure);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN_URL');
    });
  });

  describe('ALLOWED_SOURCE_HOSTS', () => {
    it('rejects hosts outside the allow-list', async () => {
      const restricted = await appWith({ allowedSourceHosts: ['images.example.com'] });
      const res = await get('/process', { url: src('/photo.jpg') }, {}, restricted);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toMatch(/allowed source hosts/);
    });

    it('allows listed hosts but re-checks every redirect hop', async () => {
      const restricted = await appWith({ allowedSourceHosts: ['127.0.0.1'] });
      expect((await get('/process', { url: src('/photo.jpg'), width: '10' }, {}, restricted)).statusCode).toBe(200);
      expect((await get('/process', { url: src('/redirect-localhost') }, {}, restricted)).statusCode).toBe(403);
    });
  });
});

describe('signed URLs (SIGNING_SECRET)', () => {
  const secret = 'integration-secret-0123';
  let signed: FastifyInstance;
  beforeAll(async () => {
    signed = await appWith({ signingSecret: secret });
  });

  it('rejects unsigned requests', async () => {
    const res = await get('/process', { url: src('/photo.jpg') }, {}, signed);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INVALID_SIGNATURE');
  });

  it('accepts a valid signature', async () => {
    const query = { url: src('/photo.jpg'), width: '20' };
    const res = await get('/process', { ...query, signature: sign(secret, '/process', query) }, {}, signed);
    expect(res.statusCode).toBe(200);
  });

  it('rejects tampered parameters and signatures replayed on another endpoint', async () => {
    const query = { url: src('/photo.jpg'), width: '20' };
    const signature = sign(secret, '/process', query);
    expect((await get('/process', { ...query, width: '4000', signature }, {}, signed)).statusCode).toBe(403);
    expect((await get('/info', { url: query.url, signature }, {}, signed)).statusCode).toBe(403);
  });

  it('does not require signatures on discovery and health routes', async () => {
    expect((await get('/health', {}, {}, signed)).statusCode).toBe(200);
    expect((await get('/', {}, {}, signed)).json().authentication.signature).toMatch(/Required/);
  });
});

describe('GET /info', () => {
  it('returns image metadata', async () => {
    const res = await get('/info', { url: src('/alpha.png') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ format: 'png', width: 400, height: 400, hasAlpha: true, pages: 1 });
  });

  it('validates parameters', async () => {
    expect((await get('/info')).statusCode).toBe(400);
    expect((await get('/info', { url: src('/alpha.png'), width: '1' })).statusCode).toBe(400);
    expect((await get('/info', { url: src('/corrupt.jpg') })).statusCode).toBe(422);
  });
});

describe('misc routes', () => {
  it('GET / lists endpoints and the parameters each one accepts', async () => {
    const body = (await get('/')).json();
    expect(body.endpoints).toHaveProperty(['GET /process']);
    expect(Object.keys(body.parameters)).toEqual(['/process', '/video/thumbnail', '/info']);
    expect(body.parameters['/process'].width).toMatchObject({ type: 'integer', minimum: 1, maximum: 5000 });
    expect(body.parameters['/process'].format).not.toHaveProperty('default');
    expect(body.parameters['/video/thumbnail'].format.default).toBe('jpeg');
    expect(body.parameters['/video/thumbnail'].time).toMatchObject({ default: 0, required: false });
    expect(body.authentication).toHaveProperty('api_key | X-API-Key header');
  });

  it('GET /health reports job stats', async () => {
    expect((await get('/health')).json()).toMatchObject({ status: 'ok', jobs: { active: 0, queued: 0 } });
  });

  it('maps framework 4xx errors and unexpected errors to the standard envelope', async () => {
    const custom = await appWith({});
    custom.get('/teapot', async () => {
      throw Object.assign(new Error('short and stout'), { statusCode: 418 });
    });
    custom.get('/boom', async () => {
      throw new Error('secret internals');
    });

    const teapot = await get('/teapot', {}, {}, custom);
    expect(teapot.statusCode).toBe(418);
    expect(teapot.json().error).toMatchObject({ code: 'INVALID_PARAMETER', message: 'short and stout' });

    const boom = await get('/boom', {}, {}, custom);
    expect(boom.statusCode).toBe(500);
    expect(boom.json().error).toEqual({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
  });

  it('accepts the request Swagger UI sends, with every default filled in', async () => {
    const res = await get('/process', { url: src('/photo.jpg'), width: '400', crop: 'scale', gravity: 'center' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-image-width']).toBe('400');
  });

  it('unknown route -> JSON 404', async () => {
    const res = await get('/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
