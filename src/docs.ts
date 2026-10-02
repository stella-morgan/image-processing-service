import swagger, { type StaticDocumentSpec } from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

export async function registerDocs(app: FastifyInstance, spec: object) {
  const document = spec as StaticDocumentSpec['document'];
  await app.register(swagger, { mode: 'static', specification: { document } });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, tryItOutEnabled: true },
    transformSpecification: (spec, request) => ({
      ...spec,
      servers: [{ url: `${request.protocol}://${request.host}` }],
    }),
  });
}
