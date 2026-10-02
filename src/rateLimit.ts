import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import type { Config } from './config.js';
import { type ApiClient, ApiKeyRegistry } from './lib/apiKeys.js';
import { ApiError } from './lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    client?: ApiClient;
  }
}

export interface RateLimitStatus {
  enabled: boolean;
  store: 'memory' | 'redis';
  connected: boolean;
}

const routeOf = (request: FastifyRequest) => request.routeOptions.url ?? '';

function readApiKey(request: FastifyRequest): string | undefined {
  const header = request.headers['x-api-key'];
  const query = (request.query as Record<string, unknown>).api_key;
  if (Array.isArray(header) || Array.isArray(query)) {
    throw new ApiError('INVALID_PARAMETER', undefined, [
      { field: 'api_key', message: 'The API key was provided more than once.' },
    ]);
  }
  if (typeof header === 'string' && typeof query === 'string' && header !== query) {
    throw new ApiError('INVALID_PARAMETER', undefined, [
      { field: 'api_key', message: 'Different API keys were sent in the X-API-Key header and the api_key parameter.' },
    ]);
  }
  const key = header ?? query;
  return typeof key === 'string' ? key : undefined;
}

export async function registerRateLimit(
  app: FastifyInstance,
  config: Config,
  protectedRoutes: ReadonlySet<string>,
): Promise<() => RateLimitStatus> {
  const registry = new ApiKeyRegistry(config.apiKeys);
  const isProtected = (request: FastifyRequest) => protectedRoutes.has(routeOf(request));

  app.decorateRequest('client', undefined);
  app.addHook('onRequest', async (request) => {
    if (!isProtected(request)) return;
    const key = readApiKey(request);
    if (key === undefined) {
      if (config.requireApiKey) {
        throw new ApiError(
          'INVALID_API_KEY',
          'An API key is required. Send it in the X-API-Key header or the api_key parameter.',
        );
      }
      return;
    }
    const client = registry.lookup(key);
    if (!client) throw new ApiError('INVALID_API_KEY');
    request.client = client;
  });

  const enabled = config.rateLimitMax > 0;
  let redis: Redis | undefined;

  if (enabled && config.redisUrl) {
    const store = new Redis(config.redisUrl, {
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    let lastError = '';
    store.on('error', (err: Error) => {
      if (err.message === lastError) return;
      lastError = err.message;
      app.log.warn({ err }, 'Rate-limit store unavailable; requests are not being rate limited');
    });
    store.on('ready', () => {
      lastError = '';
      app.log.info('Rate-limit store connected');
    });
    app.addHook('onClose', async () => {
      store.disconnect();
    });
    redis = store;
  }

  if (enabled) {
    await app.register(rateLimit, {
      global: true,
      max: async (request) => request.client?.limit ?? config.rateLimitMax,
      timeWindow: config.rateLimitWindowMs,
      keyGenerator: (request) => (request.client ? `key:${request.client.name}` : `ip:${normalizeIP(request.ip)}`),
      allowList: (request) => !isProtected(request),
      enableDraftSpec: true,
      redis,
      nameSpace: 'image-service:rate-limit:',
      skipOnError: true,
      errorResponseBuilder: (_request, context) =>
        new ApiError('RATE_LIMITED', `Rate limit of ${context.max} requests exceeded. Retry in ${context.after}.`),
    });
  }

  return () => ({
    enabled,
    store: redis ? 'redis' : 'memory',
    connected: redis ? redis.status === 'ready' : true,
  });
}
