import { fileURLToPath } from 'node:url';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

const SPEC_PATH = fileURLToPath(new URL('../openapi.yaml', import.meta.url));

export async function registerDocs(app: FastifyInstance) {
  await app.register(swagger, { mode: 'static', specification: { path: SPEC_PATH, baseDir: '' } });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, tryItOutEnabled: true },
    transformSpecification: (spec, request) => ({
      ...spec,
      servers: [{ url: `${request.protocol}://${request.host}` }],
    }),
  });
}
