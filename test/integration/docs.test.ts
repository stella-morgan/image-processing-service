import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

let app: FastifyInstance;
let signed: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  signed = await buildApp({ logger: false, config: { signingSecret: 'docs-secret-0123456789' } });
});

afterAll(async () => {
  await Promise.all([app.close(), signed.close()]);
});

const get = (url: string, headers: Record<string, string> = {}, on = app) => on.inject({ method: 'GET', url, headers });

interface Parameter {
  $ref?: string;
  name?: string;
}

describe('API docs', () => {
  it('GET /docs serves Swagger UI', async () => {
    const res = await get('/docs/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('swagger');
  });

  it('GET /docs/json serves the spec with the server set to the requesting host', async () => {
    const res = await get('/docs/json', { host: 'images.example.com' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(['/process', '/video/thumbnail', '/info', '/health']);
    expect(spec.servers).toEqual([{ url: 'http://images.example.com' }]);
  });

  it('stays reachable without a signature when signing is enabled', async () => {
    expect((await get('/docs/json', {}, signed)).statusCode).toBe(200);
  });

  it('documents only parameters the server accepts', async () => {
    const spec = (await get('/docs/json')).json();
    const samples: Record<string, string> = {
      width: '10',
      height: '10',
      format: 'png',
      quality: '50',
      crop: 'scale',
      gravity: 'center',
      background: 'fff',
      time: '1',
    };

    for (const path of ['/process', '/video/thumbnail', '/info']) {
      const names = (spec.paths[path].get.parameters as Parameter[]).map(
        (p) => p.name ?? spec.components.parameters[p.$ref!.split('/').pop()!].name,
      );
      for (const name of names.filter((n) => n !== 'url')) {
        const query = new URLSearchParams({ url: 'http://unresolvable.invalid/a', [name]: samples[name] ?? '1' });
        const res = await get(`${path}?${query}`);
        const details: { message: string }[] = res.json().error?.details ?? [];
        expect(details.map((d) => d.message).join(), `${path} ${name}`).not.toMatch(/Unknown parameter/);
      }
    }
  });
});
