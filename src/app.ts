import Fastify, { type FastifyInstance } from 'fastify';
import { type Config, loadConfig } from './config.js';
import { registerDocs } from './docs.js';
import { redactSecrets } from './lib/apiKeys.js';
import { ApiError } from './lib/errors.js';
import type { Health } from './lib/responses.js';
import { verifySignature } from './lib/signing.js';
import { buildOpenApiSpec, parameterSummary } from './openapi.js';
import { registerRateLimit } from './rateLimit.js';
import { processRoutes } from './routes/process.js';
import { videoRoutes } from './routes/video.js';
import { createServices, type Services } from './services.js';

export interface BuildOptions {
  config?: Partial<Config>;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
  }
}

const PROTECTED_ROUTES = new Set(['/process', '/video/thumbnail', '/info']);

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const config: Config = { ...loadConfig(), ...options.config };
  const services = createServices(config);
  const spec = buildOpenApiSpec(config);

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            serializers: {
              req: (req) => ({ method: req.method, url: redactSecrets(req.url), remoteAddress: req.ip }),
            },
          },
    trustProxy: config.trustProxy,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  });

  app.decorate('services', services);

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });

  const rateLimitStatus = await registerRateLimit(app, config, PROTECTED_ROUTES);

  if (config.signingSecret) {
    const secret = config.signingSecret;
    app.addHook('preValidation', async (request) => {
      const path = request.routeOptions.url ?? '';
      if (!PROTECTED_ROUTES.has(path)) return;
      if (!verifySignature(secret, path, request.query as Record<string, unknown>)) {
        throw new ApiError('INVALID_SIGNATURE');
      }
    });
  }

  app.setErrorHandler((error, request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (error instanceof ApiError) {
      if (error.code === 'SERVER_BUSY') reply.header('Retry-After', '1');
      if (error.status >= 500) request.log.warn({ err: error }, error.message);
      return reply.code(error.status).send(error.toJSON());
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send(new ApiError('INVALID_PARAMETER', (error as Error).message).toJSON());
    }
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send(new ApiError('INTERNAL_ERROR').toJSON());
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .header('Cache-Control', 'no-store')
      .send(
        new ApiError(
          'NOT_FOUND',
          `Route ${request.method} ${request.url.split('?')[0]} not found. See GET / for available endpoints.`,
        ).toJSON(),
      );
  });

  app.get('/', async () => ({
    name: 'image-processing-service',
    endpoints: {
      'GET /process': 'Resize, crop and convert a remote image.',
      'GET /video/thumbnail': 'Extract a frame from a remote video as an image.',
      'GET /info': 'Return metadata (format, dimensions, size) for a remote image.',
      'GET /health': 'Liveness check.',
      'GET /docs': 'Interactive API documentation (Swagger UI). The raw spec is at /docs/json and /docs/yaml.',
    },
    parameters: parameterSummary(spec),
    authentication: {
      signature: config.signingSecret
        ? 'Required: HMAC-SHA256 of the request (see README).'
        : 'Not required (signing disabled).',
      'api_key | X-API-Key header': config.requireApiKey
        ? 'Required: identifies the client for rate limiting.'
        : 'Optional: identifies the client for rate limiting; anonymous requests are limited per IP.',
    },
    example: '/process?url=https://picsum.photos/id/237/1200/800.jpg&width=500&height=300&crop=fill&format=webp',
  }));

  app.get(
    '/health',
    async (): Promise<Health> => ({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      jobs: services.limiter.stats,
      rateLimit: rateLimitStatus(),
    }),
  );

  await registerDocs(app, spec);
  await app.register(processRoutes, { services });
  await app.register(videoRoutes, { services });

  app.addHook('onClose', async () => {
    await services.fetcher.close();
  });

  return app;
}
