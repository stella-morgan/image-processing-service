import Fastify, { type FastifyInstance } from 'fastify';
import { type Config, loadConfig } from './config.js';
import { ApiError } from './lib/errors.js';
import { CROP_MODES, GRAVITIES, OUTPUT_FORMATS } from './lib/params.js';
import { verifySignature } from './lib/signing.js';
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

const SIGNED_ROUTES = new Set(['/process', '/video/thumbnail', '/info']);

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const config: Config = { ...loadConfig(), ...options.config };
  const services = createServices(config);

  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  });

  app.decorate('services', services);

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });

  if (config.signingSecret) {
    const secret = config.signingSecret;
    app.addHook('onRequest', async (request) => {
      const path = request.url.split('?')[0]!;
      if (!SIGNED_ROUTES.has(path)) return;
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
    },
    parameters: {
      url: 'Absolute http(s) URL of the source asset (required).',
      'width | w': `Target width in pixels (1-${config.maxDimension}).`,
      'height | h': `Target height in pixels (1-${config.maxDimension}).`,
      'format | f': `Output format: ${[...OUTPUT_FORMATS, 'jpg', 'auto'].join(', ')}. Defaults to the source format.`,
      'quality | q': 'Output quality 1-100 (not for gif).',
      'crop | c': `Resize mode: ${CROP_MODES.join(', ')}. Defaults to scale.`,
      'gravity | g': `Anchor for crop=fill only: ${GRAVITIES.join(', ')}. Defaults to center.`,
      'background | b': 'Hex colour (ff0000) or "transparent", for crop=pad or flattening to jpeg.',
      'time | t': 'Video thumbnail only: timestamp in seconds. Defaults to 0.',
      signature: config.signingSecret
        ? 'Required: HMAC-SHA256 of the request (see README).'
        : 'Not required (signing disabled).',
    },
    example: '/process?url=https://picsum.photos/id/237/1200/800.jpg&width=500&height=300&crop=fill&format=webp',
  }));

  app.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    jobs: services.limiter.stats,
  }));

  await app.register(processRoutes, { services });
  await app.register(videoRoutes, { services });

  app.addHook('onClose', async () => {
    await services.fetcher.close();
  });

  return app;
}
