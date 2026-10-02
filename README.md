# Image Processing Service

A Cloudinary-style image transformation API, written in TypeScript. Give it the URL of a remote image and it **resizes**, **crops** and **converts** the image on the fly. It can also pull a **thumbnail from a video**.

Built with [Fastify](https://fastify.dev), [sharp](https://sharp.pixelplumbing.com) and [ffmpeg](https://ffmpeg.org) (bundled, so there's nothing extra to install).

**More detail:** [NOTES.md](NOTES.md) has the full API reference, configuration, security and implementation notes.

## Requirements

Node.js 22.19 or newer (see `.nvmrc`).

## Run it

```bash
npm install
npm run dev
```

The API is now at `http://localhost:3000`, and it reloads when you change the code.

## Try it

```bash
# Resize
curl -o resized.jpg "http://localhost:3000/process?url=https://picsum.photos/id/237/1200/800.jpg&width=500&height=300"

# Convert PNG to JPEG
curl -o converted.jpg "http://localhost:3000/process?url=https://www.gstatic.com/webp/gallery3/1.png&format=jpeg&quality=80"

# Resize, crop and convert in one go
curl -o combined.webp "http://localhost:3000/process?url=https://picsum.photos/id/237/1200/800.jpg&width=800&height=600&format=webp&crop=fill"

# Video thumbnail (this sample video is 5 seconds long)
curl -o thumb.jpg "http://localhost:3000/video/thumbnail?url=https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4&time=2&width=320"
```

These URLs also work directly in a browser or an `<img src>` tag.

For interactive docs, open [http://localhost:3000/docs](http://localhost:3000/docs). You can try every endpoint there.

## Endpoints

| Endpoint | What it does |
| --- | --- |
| `GET /process` | Resize, crop and convert a remote image |
| `GET /video/thumbnail` | Extract a frame from a remote video as an image |
| `GET /info` | Return an image's format, dimensions and size |
| `GET /docs` | Interactive API docs (Swagger UI) |
| `GET /health` | Health check |

Parameters, error codes and configuration are listed in [NOTES.md](NOTES.md).

## Test

```bash
npm test
```

The tests need no network access. `npm run lint` and `npm run typecheck` run the other checks that CI runs.

## Production

```bash
npm run build
npm start
```

Or with Docker:

```bash
docker build -t image-service .
docker run -p 3000:3000 image-service
```

Settings are environment variables; `.env.example` lists them all.
