import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type ProcessedImage, preferredModernFormat } from '../lib/imageProcessor.js';
import type { ImageTransform } from '../lib/params.js';
import type { Services } from '../services.js';

export interface CachedResult {
  image: ProcessedImage;
  etag: string;
}

export function cacheKey(
  kind: string,
  url: URL,
  transform: ImageTransform,
  extra: Record<string, unknown>,
  accept?: string,
) {
  return JSON.stringify({
    kind,
    url: url.href,
    ...transform,
    ...extra,
    ...(transform.format === 'auto' ? { accept: preferredModernFormat(accept) ?? 'basic' } : {}),
  });
}

export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => tag.trim() === '*' || bare(tag) === bare(etag));
}

type CacheStatus = 'HIT' | 'MISS' | 'COALESCED';

async function resolve(
  services: Services,
  key: string,
  produce: () => Promise<ProcessedImage>,
): Promise<[CachedResult, CacheStatus]> {
  const cached = services.cache.get(key);
  if (cached) return [cached, 'HIT'];

  const pending = services.inflight.get(key);
  if (pending) return [await pending, 'COALESCED'];

  const job = services.limiter
    .run(produce)
    .then((image) => {
      const result = { image, etag: `"${createHash('sha1').update(image.buffer).digest('base64url')}"` };
      services.cache.set(key, result);
      return result;
    })
    .finally(() => services.inflight.delete(key));
  services.inflight.set(key, job);
  return [await job, 'MISS'];
}

export async function sendCachedImage(
  request: FastifyRequest,
  reply: FastifyReply,
  services: Services,
  key: string,
  transform: ImageTransform,
  produce: () => Promise<ProcessedImage>,
) {
  const started = performance.now();
  const [{ image, etag }, status] = await resolve(services, key, produce);

  reply
    .header('Cache-Control', `public, max-age=${services.config.cacheTtlSeconds}`)
    .header('ETag', etag)
    .header('X-Cache', status)
    .header('X-Image-Width', String(image.width))
    .header('X-Image-Height', String(image.height))
    .header('X-Processing-Time-Ms', (performance.now() - started).toFixed(1));

  if (transform.format === 'auto') reply.header('Vary', 'Accept');

  if (etagMatches(request.headers['if-none-match'], etag)) {
    return reply.code(304).send();
  }

  return reply
    .type(image.contentType)
    .header('Content-Length', String(image.buffer.length))
    .header('Content-Disposition', `inline; filename="image.${image.format === 'jpeg' ? 'jpg' : image.format}"`)
    .send(image.buffer);
}
