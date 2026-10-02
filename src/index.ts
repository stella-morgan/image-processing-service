import { buildApp } from './app.js';

const app = await buildApp();

try {
  await app.listen({ port: app.services.config.port, host: app.services.config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`Received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  });
}
