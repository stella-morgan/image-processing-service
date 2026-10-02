import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Config } from './config.js';
import { ErrorBodySchema } from './lib/errors.js';
import { MIME_TYPES } from './lib/imageProcessor.js';
import { ALIASES, CASE_INSENSITIVE, imageQuerySchema, infoQuerySchema, thumbnailQuerySchema } from './lib/params.js';
import { HealthSchema, ImageInfoSchema } from './lib/responses.js';

type Json = Record<string, unknown>;

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Json {
  const result = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'throw',
    override: ({ jsonSchema: node }) => {
      if (node.minimum === Number.MIN_SAFE_INTEGER) delete node.minimum;
      if (node.maximum === Number.MAX_SAFE_INTEGER) delete node.maximum;
      if (io === 'output') delete node.additionalProperties;
    },
  }) as Json;
  const { $schema: _, ...rest } = result;
  return rest;
}

function queryParameter(name: string, field: z.ZodType): Json {
  const { description, ...schema } = jsonSchema(field, 'input');
  const alias = Object.entries(ALIASES).find(([, target]) => target === name)?.[0];
  const notes = [description, CASE_INSENSITIVE.has(name) && 'Case-insensitive.', alias && `Alias \`${alias}\`.`];
  return {
    name,
    in: 'query',
    required: !field.isOptional(),
    description: notes.filter(Boolean).join(' '),
    schema,
  };
}

function queryParameters(schema: z.ZodObject): Json[] {
  return Object.entries(schema.shape).map(([name, field]) => queryParameter(name, field as z.ZodType));
}

const ref = (kind: string, name: string) => ({ $ref: `#/components/${kind}/${name}` });

function withSharedRefs(parameters: Json[], shared: Record<string, Json>): Json[] {
  return parameters.map((p) =>
    JSON.stringify(shared[p.name as string]) === JSON.stringify(p) ? ref('parameters', p.name as string) : p,
  );
}

const rateLimitHeaders = {
  'RateLimit-Limit': ref('headers', 'RateLimit-Limit'),
  'RateLimit-Remaining': ref('headers', 'RateLimit-Remaining'),
  'RateLimit-Reset': ref('headers', 'RateLimit-Reset'),
};

const errorResponses = {
  '400': ref('responses', 'Error'),
  '401': ref('responses', 'Error'),
  '403': ref('responses', 'Error'),
  '404': ref('responses', 'Error'),
  '413': ref('responses', 'Error'),
  '415': ref('responses', 'Error'),
  '422': ref('responses', 'Error'),
  '429': ref('responses', 'RateLimited'),
  '502': ref('responses', 'Error'),
  '503': ref('responses', 'Busy'),
  '504': ref('responses', 'Error'),
};

const imageResponses = {
  '200': ref('responses', 'Image'),
  '304': { description: 'Not modified (If-None-Match matched the ETag).' },
  ...errorResponses,
};

const errorContent = { 'application/json': { schema: ref('schemas', 'Error') } };

export function buildOpenApiSpec(config: Pick<Config, 'maxDimension'>): Json {
  const imageParameters = queryParameters(imageQuerySchema(config.maxDimension));
  const shared = Object.fromEntries(imageParameters.map((p) => [p.name as string, p]));

  return {
    openapi: '3.1.0',
    info: {
      title: 'Image Processing Service',
      version,
      license: { name: 'MIT', identifier: 'MIT' },
      description: 'Cloudinary-style on-the-fly image transformation and video thumbnail API.',
    },
    servers: [{ url: 'http://localhost:3000' }],
    security: [
      {},
      { apiKeyHeader: [] },
      { apiKeyQuery: [] },
      { urlSignature: [] },
      { apiKeyHeader: [], urlSignature: [] },
      { apiKeyQuery: [], urlSignature: [] },
    ],
    paths: {
      '/process': {
        get: {
          summary: 'Resize, crop and convert a remote image',
          operationId: 'processImage',
          parameters: Object.keys(shared).map((name) => ref('parameters', name)),
          responses: imageResponses,
        },
      },
      '/video/thumbnail': {
        get: {
          summary: 'Extract a frame from a remote video',
          description: 'Accepts every /process parameter plus `time`. Output defaults to JPEG.',
          operationId: 'videoThumbnail',
          parameters: withSharedRefs(queryParameters(thumbnailQuerySchema(config.maxDimension)), shared),
          responses: imageResponses,
        },
      },
      '/info': {
        get: {
          summary: 'Metadata for a remote image',
          operationId: 'imageInfo',
          parameters: withSharedRefs(queryParameters(infoQuerySchema), shared),
          responses: {
            '200': {
              description: 'Image metadata',
              headers: rateLimitHeaders,
              content: { 'application/json': { schema: ref('schemas', 'ImageInfo') } },
            },
            ...errorResponses,
          },
        },
      },
      '/health': {
        get: {
          summary: 'Liveness probe',
          operationId: 'health',
          security: [],
          responses: {
            '200': {
              description: 'Service is up',
              content: { 'application/json': { schema: ref('schemas', 'Health') } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKeyHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Identifies the client for rate limiting. Optional unless the server sets REQUIRE_API_KEY.',
        },
        apiKeyQuery: {
          type: 'apiKey',
          in: 'query',
          name: 'api_key',
          description: 'Same as X-API-Key, for image URLs embedded in web pages, which cannot send headers.',
        },
        urlSignature: {
          type: 'apiKey',
          in: 'query',
          name: 'signature',
          description:
            'Required only when the server has SIGNING_SECRET set. base64url HMAC-SHA256 of the canonical request (see README).',
        },
      },
      parameters: shared,
      headers: {
        ETag: { schema: { type: 'string' } },
        'X-Cache': { schema: { type: 'string', enum: ['HIT', 'MISS', 'COALESCED'] } },
        'X-Image-Width': { schema: { type: 'integer' } },
        'X-Image-Height': { schema: { type: 'integer' } },
        'X-Request-Id': { schema: { type: 'string' } },
        'RateLimit-Limit': { description: 'Requests allowed per window for this client.', schema: { type: 'integer' } },
        'RateLimit-Remaining': { description: 'Requests left in the current window.', schema: { type: 'integer' } },
        'RateLimit-Reset': { description: 'Seconds until the window resets.', schema: { type: 'integer' } },
      },
      responses: {
        Image: {
          description: 'The processed image',
          headers: {
            ETag: ref('headers', 'ETag'),
            'X-Cache': ref('headers', 'X-Cache'),
            'X-Image-Width': ref('headers', 'X-Image-Width'),
            'X-Image-Height': ref('headers', 'X-Image-Height'),
            'X-Request-Id': ref('headers', 'X-Request-Id'),
            ...rateLimitHeaders,
          },
          content: Object.fromEntries(
            Object.values(MIME_TYPES).map((type) => [type, { schema: { type: 'string', format: 'binary' } }]),
          ),
        },
        Error: { description: 'Error', content: errorContent },
        RateLimited: {
          description: 'Rate limit exceeded for this client',
          headers: { 'Retry-After': { schema: { type: 'integer' } }, ...rateLimitHeaders },
          content: errorContent,
        },
        Busy: {
          description: 'Server at capacity',
          headers: { 'Retry-After': { schema: { type: 'integer' } } },
          content: errorContent,
        },
      },
      schemas: {
        Error: jsonSchema(ErrorBodySchema, 'output'),
        ImageInfo: jsonSchema(ImageInfoSchema, 'output'),
        Health: jsonSchema(HealthSchema, 'output'),
      },
    },
  };
}
