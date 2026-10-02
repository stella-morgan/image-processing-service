import type { FastifyInstance } from 'fastify';
import { processImage } from '../lib/imageProcessor.js';
import { parseThumbnailParams } from '../lib/params.js';
import { extractFrame } from '../lib/videoThumbnail.js';
import type { Services } from '../services.js';
import { cacheKey, sendCachedImage } from './respond.js';

export async function videoRoutes(app: FastifyInstance, { services }: { services: Services }) {
  app.get('/video/thumbnail', async (request, reply) => {
    const { url, transform, time } = parseThumbnailParams(request.query, services.config.maxDimension);
    const accept = request.headers.accept;
    const key = cacheKey('thumbnail', url, transform, { time }, accept);

    return sendCachedImage(request, reply, services, key, transform, async () => {
      const source = await services.fetcher.fetch(url, { maxBytes: services.config.maxVideoBytes });
      const frame = await extractFrame(source.body, time, source.contentType);
      return processImage(frame, transform, { accept });
    });
  });
}
