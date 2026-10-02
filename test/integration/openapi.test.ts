import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { renderSpec, SPEC_FILE } from '../../scripts/generate-openapi.js';
import { buildApp } from '../../src/app.js';
import { ErrorBodySchema, ErrorCodes } from '../../src/lib/errors.js';
import { MIME_TYPES } from '../../src/lib/imageProcessor.js';
import { imageQuerySchema, infoQuerySchema, thumbnailQuerySchema } from '../../src/lib/params.js';
import { HealthSchema, ImageInfoSchema } from '../../src/lib/responses.js';
import { buildOpenApiSpec } from '../../src/openapi.js';
import type { ImageInfo as SdkImageInfo } from '../../src/sdk/index.js';
import { type FixtureServer, startFixtureServer } from '../helpers/fixtureServer.js';

type Spec = {
  paths: Record<string, { get: { parameters?: { $ref?: string; name?: string }[] } }>;
  components: {
    parameters: Record<string, { name: string; schema: Record<string, unknown> }>;
    schemas: { Error: { properties: { error: { properties: { code: { enum: string[] } } } } } };
    responses: { Image: { content: Record<string, unknown> } };
  };
};

let fixtures: FixtureServer;
let app: FastifyInstance;

beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await buildApp({ logger: false, config: { allowPrivateNetworks: true, maxDimension: 1234 } });
});

afterAll(async () => {
  await app.close();
  await fixtures.close();
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

function parameterNames(spec: Spec, path: string): string[] {
  return (spec.paths[path]!.get.parameters ?? []).map(
    (p) => p.name ?? spec.components.parameters[p.$ref!.split('/').pop()!]!.name,
  );
}

function keysDeep(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => [`${prefix}${k}`, ...keysDeep(v, `${prefix}${k}.`)]);
}

function schemaKeysDeep(schema: z.ZodObject, prefix = ''): string[] {
  return Object.entries(schema.shape).flatMap(([k, field]) => {
    const inner = field as unknown as { shape?: unknown };
    return [`${prefix}${k}`, ...(inner.shape ? schemaKeysDeep(field as unknown as z.ZodObject, `${prefix}${k}.`) : [])];
  });
}

describe('generated OpenAPI spec', () => {
  it('matches the committed openapi.yaml (run `npm run openapi` after changing a schema)', () => {
    expect(readFileSync(SPEC_FILE, 'utf8')).toBe(renderSpec());
  });

  it('is what /docs serves, built from the running config', async () => {
    const served = (await get('/docs/json', { host: 'images.example.com' })).json();
    expect(served).toEqual({
      ...buildOpenApiSpec({ maxDimension: 1234 }),
      servers: [{ url: 'http://images.example.com' }],
    });
    expect(served.components.parameters.width.schema.maximum).toBe(1234);
    expect(served.components.parameters.height.schema.maximum).toBe(1234);
  });

  it('documents exactly the query parameters each route parses', () => {
    const spec = buildOpenApiSpec({ maxDimension: 5000 }) as Spec;
    expect(parameterNames(spec, '/process')).toEqual(Object.keys(imageQuerySchema(5000).shape));
    expect(parameterNames(spec, '/video/thumbnail')).toEqual(Object.keys(thumbnailQuerySchema(5000).shape));
    expect(parameterNames(spec, '/info')).toEqual(Object.keys(infoQuerySchema.shape));
  });

  it('lists every error code and every output content type', () => {
    const spec = buildOpenApiSpec({ maxDimension: 5000 }) as Spec;
    expect(spec.components.schemas.Error.properties.error.properties.code.enum).toEqual(Object.keys(ErrorCodes));
    expect(Object.keys(spec.components.responses.Image.content)).toEqual(Object.values(MIME_TYPES));
  });
});

describe('responses match their documented schemas', () => {
  it('/info', async () => {
    const body = (await get(`/info?url=${encodeURIComponent(`${fixtures.baseUrl}/alpha.png`)}`)).json();
    expect(ImageInfoSchema.parse(body)).toEqual(body);
    expect(keysDeep(body).sort()).toEqual(schemaKeysDeep(ImageInfoSchema).sort());
  });

  it('/health', async () => {
    const body = (await get('/health')).json();
    expect(HealthSchema.parse(body)).toEqual(body);
    expect(keysDeep(body).sort()).toEqual(schemaKeysDeep(HealthSchema).sort());
  });

  it.each([
    ['validation error with details', '/process?widht=5'],
    ['unknown route', '/nope'],
    ['source error', '/process?url=http://unresolvable.invalid/a.jpg'],
  ])('error envelope: %s', async (_name, url) => {
    const body = (await get(url)).json();
    expect(ErrorBodySchema.parse(body)).toEqual(body);
  });

  it('the SDK ImageInfo type is the documented response type', () => {
    expectTypeOf<SdkImageInfo>().toEqualTypeOf<z.infer<typeof ImageInfoSchema>>();
  });
});
