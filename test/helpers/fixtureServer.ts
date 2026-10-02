import http from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';

export type Handler = (res: http.ServerResponse, req: http.IncomingMessage) => void;

export interface FixtureServer {
  baseUrl: string;
  hits: Map<string, number>;
  close: () => Promise<void>;
}

export function send(res: http.ServerResponse, status: number, type: string, body: Buffer) {
  res.writeHead(status, { 'content-type': type, 'content-length': body.length });
  res.end(body);
}

function redirect(res: http.ServerResponse, location: string) {
  res.writeHead(302, { location });
  res.end();
}

export async function startFixtureServer(extraRoutes: Record<string, Handler> = {}): Promise<FixtureServer> {
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3366cc' } })
    .jpeg()
    .toBuffer();
  const png = await sharp({
    create: { width: 400, height: 400, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
  })
    .png()
    .toBuffer();

  let baseUrl = '';
  const routes: Record<string, Handler> = {
    '/photo.jpg': (res) => send(res, 200, 'image/jpeg', jpeg),
    '/alpha.png': (res) => send(res, 200, 'image/png', png),
    '/octet': (res) => send(res, 200, 'application/octet-stream', jpeg),
    '/page.html': (res) => send(res, 200, 'text/html', Buffer.from('<html>not an image</html>')),
    '/corrupt.jpg': (res) => send(res, 200, 'image/jpeg', Buffer.from('definitely not a jpeg')),
    '/empty.jpg': (res) => send(res, 200, 'image/jpeg', Buffer.alloc(0)),
    '/redirect': (res) => redirect(res, '/photo.jpg'),
    '/redirect-loop': (res) => redirect(res, '/redirect-loop'),
    '/redirect-localhost': (res) => redirect(res, `${baseUrl.replace('127.0.0.1', 'localhost')}/photo.jpg`),
    '/server-error': (res) => send(res, 500, 'text/plain', Buffer.from('boom')),
    '/huge': (res) => send(res, 200, 'image/jpeg', Buffer.alloc(2 * 1024 * 1024, 1)),
    '/delayed.jpg': (res) => {
      setTimeout(() => send(res, 200, 'image/jpeg', jpeg), 150);
    },
    '/hang': () => {},
    ...extraRoutes,
  };

  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const handler = routes[path];
    if (handler) return handler(res, req);
    send(res, 404, 'text/plain', Buffer.from('not found'));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
