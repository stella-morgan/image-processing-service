import type { Config } from './config.js';
import { LruCache } from './lib/cache.js';
import { SourceFetcher } from './lib/fetcher.js';
import { ConcurrencyLimiter } from './lib/limiter.js';
import type { CachedResult } from './routes/respond.js';

export interface Services {
  config: Config;
  fetcher: SourceFetcher;
  cache: LruCache<CachedResult>;
  limiter: ConcurrencyLimiter;
  inflight: Map<string, Promise<CachedResult>>;
}

export function createServices(config: Config): Services {
  return {
    config,
    fetcher: new SourceFetcher({
      maxBytes: config.maxImageBytes,
      timeoutMs: config.fetchTimeoutMs,
      allowPrivateNetworks: config.allowPrivateNetworks,
      allowedHosts: config.allowedSourceHosts,
    }),
    cache: new LruCache<CachedResult>({
      maxEntries: config.cacheMaxEntries,
      maxBytes: config.cacheMaxBytes,
      ttlMs: config.cacheTtlSeconds * 1000,
      sizeOf: (r) => r.image.buffer.length,
    }),
    limiter: new ConcurrencyLimiter(config.maxConcurrentJobs, config.maxQueuedJobs),
    inflight: new Map(),
  };
}
