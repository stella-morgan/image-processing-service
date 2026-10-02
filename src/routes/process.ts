import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { ApiError } from '../lib/errors.js';
import { processImage } from '../lib/imageProcessor.js';
import { parseInfoParams, parseProcessParams } from '../lib/params.js';
import type { Services } from '../services.js';
import { cacheKey, sendCachedImage } from './respond.js';

export async function processRoutes(app: FastifyInstance, { services }: { services: Services }) {
  app.get('/process', async (request, reply) => {
    const { url, transform } = parseProcessParams(request.query, services.config.maxDimension);
    const accept = request.headers.accept;
    const key = cacheKey('process', url, transform, {}, accept);

    return sendCachedImage(request, reply, services, key, transform, async () => {
      const source = await services.fetcher.fetch(url);
      return processImage(source.body, transform, { accept, sourceContentType: source.contentType });
    });
  });

  app.get('/info', async (request, reply) => {
    const url = parseInfoParams(request.query);
    const info = await services.limiter.run(async () => {
      const source = await services.fetcher.fetch(url);
      try {
        const m = await sharp(source.body).metadata();
        return {
          url: source.finalUrl.href,
          format: m.format,
          width: m.width,
          height: m.pageHeight ?? m.height,
          bytes: source.body.length,
          hasAlpha: m.hasAlpha ?? false,
          pages: m.pages ?? 1,
          orientation: m.orientation ?? null,
        };
      } catch {
        throw new ApiError('UNPROCESSABLE_SOURCE', 'The source asset could not be decoded as an image.');
      }
    });
    reply.header('Cache-Control', `public, max-age=${services.config.cacheTtlSeconds}`);
    return info;
  });
}
