# Image Processing Service

A Cloudinary-style image transformation API, written in TypeScript. You pass it the URL of a remote image and it **resizes**, **crops** and **converts** the image on the fly. It can also pull a **thumbnail from a video**.

```
GET /process?url=https://picsum.photos/id/237/1200/800.jpg&width=500&height=300&crop=fill&format=webp
```

Built with [Fastify](https://fastify.dev), [sharp](https://sharp.pixelplumbing.com) (libvips) and [ffmpeg](https://ffmpeg.org) (bundled through `ffmpeg-static`, so you don't need a system install).

---

## Quick start

Requirements: **Node.js 22.19+** (see `.nvmrc`). Nothing else is needed.

```bash
npm install
npm run dev          # http://localhost:3000, with reload on change
```

Try it:

```bash
# Resize
curl -o out.jpg "http://localhost:3000/process?url=https://picsum.photos/id/237/1200/800.jpg&width=500&height=300"

# Convert format
curl -o out.jpg "http://localhost:3000/process?url=https://www.gstatic.com/webp/gallery3/1.png&format=jpeg&quality=80"

# Combine operations
curl -o out.webp "http://localhost:3000/process?url=https://picsum.photos/id/237/1200/800.jpg&width=800&height=600&format=webp&crop=fill"

# Video thumbnail
curl -o thumb.jpg "http://localhost:3000/video/thumbnail?url=https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4&time=2&width=320"
```

Every URL can also go straight into a browser or an `<img src>` tag.

**Interactive docs:** open [http://localhost:3000/docs](http://localhost:3000/docs) for Swagger UI. You can try every endpoint from the browser, and images render inline in the response.

### Commands

| Command | What it does |
| --- | --- |
| `npm test` | Runs all unit and integration tests (no network needed) |
| `npm run test:coverage` | Runs the tests with coverage; fails below the thresholds in `vitest.config.ts` |
| `npm run lint` | Biome lint and format check (`npm run lint:fix` to apply fixes) |
| `npm run typecheck` | Runs the TypeScript type check |
| `npm run build && npm start` | Production build and run |
| `docker build -t image-service . && docker run -p 3000:3000 image-service` | Runs in Docker |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests with coverage and a build on Node 22, 24 and 26. It then builds the Docker image and smoke-tests `/health`.

---

## API reference

Interactive documentation is served at **`/docs`** (Swagger UI). The OpenAPI 3.1 spec it renders is [`openapi.yaml`](openapi.yaml), also served at `/docs/json` and `/docs/yaml`. That's useful for generating clients in other languages. The spec's `servers` entry is set to whichever host serves it, so "Try it out" works on any port or domain. `GET /` also returns a summary of all endpoints and parameters.

### `GET /process`

Fetches the image at `url`, applies the transformations and returns the image bytes.

| Parameter | Alias | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `url` | | absolute http(s) URL | **required** | Source image |
| `width` | `w` | int, 1 to 5000 | | Target width in px |
| `height` | `h` | int, 1 to 5000 | | Target height in px |
| `format` | `f` | `jpeg` `jpg` `png` `webp` `avif` `gif` `tiff` `auto` | source format | Output format. `auto` picks AVIF, then WebP, then JPEG/PNG based on the `Accept` header |
| `quality` | `q` | int, 1 to 100 | 80 (AVIF: 50) | Lossy quality. For PNG it turns on palette quantisation. Not supported for GIF |
| `crop` | `c` | see below | `scale` | How the image is fitted into `width` × `height` |
| `gravity` | `g` | `center` `north` `south` `east` `west` `northeast` `northwest` `southeast` `southwest` `auto` | `center` | Which part to keep when `crop=fill` cuts the image. `auto` keeps the most interesting region. Only valid with `crop=fill` |
| `background` | `b` | hex (`ff0000`, `#fff`) or `transparent` | white for JPEG, otherwise transparent | Padding colour for `crop=pad`, or the colour transparency is flattened onto for `format=jpeg`/`auto` |
| `signature` | | string | | Required only when signing is enabled (see [Signed URLs](#signed-urls)) |

The short aliases follow Cloudinary's naming, so `?w=500&h=300&c=fill&f=webp` works too.

#### Crop modes (Cloudinary semantics)

| `crop` | Result size | Keeps aspect ratio? | Notes |
| --- | --- | --- | --- |
| `scale` (default) | exactly W×H | only when one dimension is given | Stretches if both are given |
| `fit` | fits inside W×H | yes | May upscale |
| `limit` | fits inside W×H | yes | Never upscales |
| `fill` | exactly W×H | yes | Cuts off the overflow based on `gravity`. Needs both dimensions |
| `pad` | exactly W×H | yes | Fills the leftover space with `background`. Needs both dimensions |

EXIF orientation is applied automatically. Animated GIF/WebP sources stay animated when the output is GIF or WebP.

### `GET /video/thumbnail`

Pulls one frame out of a remote video, then applies the same transforms as `/process`. Every `/process` parameter is accepted, plus:

| Parameter | Alias | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `time` | `t` | number of seconds (decimals allowed) | `0` | Timestamp of the frame |

Thumbnails are JPEG unless you set `format`. Supported containers are MP4/MOV, WebM/MKV, AVI, FLV, Ogg and MPEG-TS. The container is identified from the file's magic bytes; anything else gets a 415 (see [Security](#security)).

### `GET /info?url=…`

Returns metadata about an image without transforming it. This helps a client decide which transforms to request.

```json
{ "url": "https://…", "format": "jpeg", "width": 1200, "height": 800, "bytes": 84213, "hasAlpha": false, "pages": 1, "orientation": null }
```

### `GET /docs`

Swagger UI, with no signature required even when signing is enabled. The test suite checks that every parameter in the spec is accepted by the server, so the docs and the code can't drift apart.

### `GET /health`

Liveness probe. It also reports how many jobs are running and queued: `{ "status": "ok", "uptimeSeconds": 42, "jobs": { "active": 1, "queued": 0 } }`.

### Response headers

| Header | Meaning |
| --- | --- |
| `Content-Type` | MIME type of the output image |
| `Cache-Control` | `public, max-age=<CACHE_TTL_SECONDS>` on success, `no-store` on errors |
| `ETag` | Content hash. Send it back as `If-None-Match` (single, list, weak or `*`) and you get `304 Not Modified` |
| `Vary: Accept` | Only set when `format=auto` |
| `X-Cache` | `HIT` (served from cache), `MISS` (processed now) or `COALESCED` (shared the result of an identical request already in progress) |
| `X-Image-Width` / `X-Image-Height` | Final dimensions, so you don't need to decode the image |
| `X-Processing-Time-Ms` | Server-side processing time |
| `X-Request-Id` | Echoes your `X-Request-Id`, or a generated UUID, for log correlation |
| `Retry-After` | Sent with `503 SERVER_BUSY` |

---

## Errors

Every error is JSON in the same envelope. `code` is stable, so you can branch on it. `details` points at the parameter that caused the problem:

```json
{
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "One or more query parameters are invalid.",
    "details": [{ "field": "widht", "message": "Unknown parameter \"widht\". Did you mean \"width\"?" }]
  }
}
```

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `INVALID_PARAMETER` | Missing, malformed, out-of-range, unknown or duplicated parameters; options that would have no effect; `crop=fill` without both dimensions; `time` past the end of the video |
| 400 | `INVALID_URL` | Not an absolute URL, protocol isn't http(s), or the URL contains credentials |
| 403 | `INVALID_SIGNATURE` | Signing is enabled and the signature is missing, wrong, or was issued for different parameters |
| 403 | `FORBIDDEN_URL` | URL resolves to a private, loopback or link-local address, or the host isn't in `ALLOWED_SOURCE_HOSTS` |
| 404 | `SOURCE_NOT_FOUND` | Source server returned 404 or 410 |
| 404 | `NOT_FOUND` | Unknown route |
| 413 | `SOURCE_TOO_LARGE` | Source is over the byte limit or over 100 megapixels |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Source is not an image (or, for thumbnails, not a supported video container) |
| 422 | `UNPROCESSABLE_SOURCE` | Source is corrupt, empty, or can't be decoded |
| 502 | `SOURCE_FETCH_FAILED` | Source returned 5xx, DNS failed, the connection was refused, or there were too many redirects |
| 503 | `SERVER_BUSY` | All job slots and the wait queue are full; retry after `Retry-After` seconds |
| 504 | `SOURCE_TIMEOUT` | Source took longer than `FETCH_TIMEOUT_MS` |
| 500 | `INTERNAL_ERROR` | Unexpected error (logged with the request id; internals are never leaked) |

**Strict parameters, on purpose.** Unknown parameters are rejected rather than ignored. So are options that would do nothing, such as `gravity=north` without `crop=fill` or `background` without `crop=pad`. Sending a parameter's default value explicitly (e.g. `gravity=center`) is always allowed, because generated clients and Swagger UI do that. Otherwise a typo like `widht=500` would quietly return the full-size image, and that kind of bug is hard to track down.

---

## TypeScript SDK

The package exports a small typed client with no dependencies. It works in any runtime that has `fetch`: browsers, Node 18+, Deno and Bun.

```ts
import { createClient, ImageServiceError } from 'image-processing-service/sdk';

const images = createClient({ baseUrl: 'http://localhost:3000' });

// 1. Build URLs for <img> tags (no request is made)
const src = images.url('https://example.com/cat.jpg', { width: 500, height: 300, crop: 'fill', format: 'webp' });
const poster = images.thumbnailUrl('https://example.com/video.mp4', { time: 15, width: 640 });

// 2. Or fetch the bytes directly
try {
  const { data, contentType, width, height } = await images.fetch('https://example.com/cat.jpg', { width: 200 });
  const meta = await images.info('https://example.com/cat.jpg');
} catch (err) {
  if (err instanceof ImageServiceError && err.code === 'SOURCE_NOT_FOUND') {
    // show a placeholder
  }
}
```

All options are fully typed (`CropMode`, `Gravity`, `OutputFormat` …), so your editor autocompletes valid values. Inside this repo, import from `./src/sdk/index.js`.

---

## Signed URLs

An image proxy that anyone can call is free bandwidth and CPU for anyone who finds it. Set `SIGNING_SECRET` and every `/process`, `/video/thumbnail` and `/info` request must carry a `signature`. `/` and `/health` stay open.

The signature is the base64url HMAC-SHA256 of the request path plus all query parameters except `signature`, sorted by key, then value:

```
/process?url=https%3A%2F%2Fexample.com%2Fcat.jpg&width=500
```

Because the path is part of what's signed, a signature for `/info` can't be reused on `/process`. Changing any parameter makes the signature invalid.

The SDK does this for you. Use it on the server, because the secret must never reach a browser:

```ts
import { createClient } from 'image-processing-service/sdk';
import { createSigner } from 'image-processing-service/sdk/signer';

const images = createClient({ baseUrl, signer: createSigner(process.env.SIGNING_SECRET!) });
images.url('https://example.com/cat.jpg', { width: 500 }); // already signed, ready for <img src>
```

`createSigner` lives in a separate entry point so browser bundles never pull in `node:crypto`.

---

## Configuration

Set these with environment variables (see `.env.example`). They are validated at startup, so a bad value fails fast with a clear message. Empty values count as unset.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Address the server listens on |
| `LOG_LEVEL` | `info` | pino log level |
| `MAX_IMAGE_BYTES` | 20 MB | Maximum size of a downloaded image |
| `MAX_VIDEO_BYTES` | 100 MB | Maximum size of a downloaded video |
| `MAX_DIMENSION` | `5000` | Maximum `width` / `height` |
| `FETCH_TIMEOUT_MS` | `10000` | Time budget for the whole source download |
| `CACHE_MAX_ENTRIES` / `CACHE_MAX_BYTES` | `500` / 100 MB | Result cache limits; whichever is reached first triggers eviction |
| `CACHE_TTL_SECONDS` | `3600` | Cache lifetime, also used for `Cache-Control: max-age`. `0` turns the cache off |
| `MAX_CONCURRENT_JOBS` | number of CPU cores | Fetch + transform jobs running at once |
| `MAX_QUEUED_JOBS` | `100` | Jobs allowed to wait for a slot before requests get `503` |
| `SIGNING_SECRET` | unset | Turns on [signed URLs](#signed-urls). At least 16 characters |
| `ALLOWED_SOURCE_HOSTS` | unset (any public host) | Comma-separated hosts that may be fetched, e.g. `images.example.com,*.cdn.example.com`. Checked on every redirect |
| `ALLOW_PRIVATE_NETWORKS` | `false` | Allows fetching from localhost or private IPs. **Only for local development** |

---

## Project structure

```
src/
  app.ts                 Fastify app factory: signature check, error handler, routes, discovery endpoint
  docs.ts                Swagger UI at /docs, served from openapi.yaml
  index.ts               Entry point and graceful shutdown
  config.ts              Validated env configuration
  services.ts            Dependency wiring (fetcher, cache, limiter, in-flight jobs)
  routes/
    process.ts           GET /process, GET /info
    video.ts             GET /video/thumbnail
    respond.ts           Cache lookup, request coalescing, ETag/304 and response headers
  lib/
    params.ts            Query parsing and validation (zod), aliases, typo suggestions, cross-field rules
    fetcher.ts           Safe remote fetch: SSRF guard, host allow-list, redirects, size and time limits
    signing.ts           HMAC request signing and verification
    imageProcessor.ts    sharp pipeline: resize modes, format negotiation, encoding
    videoThumbnail.ts    Container detection and ffmpeg frame extraction
    cache.ts             LRU cache bounded by entries, bytes and TTL
    limiter.ts           Concurrency limiter with a bounded queue
    errors.ts            ApiError and the error-code catalogue
  sdk/
    index.ts             Typed client SDK
    signer.ts            Node-only request signer for the SDK
test/
  unit/                  Params, config, errors, SSRF checks, DNS guard, signing, cache, limiter, container detection
  integration/           HTTP tests per endpoint against a local fixture server, SDK tests, docs tests
  helpers/               Fixture server and generated test videos
openapi.yaml             OpenAPI 3.1 spec (rendered at /docs)
```

## Testing

```bash
npm test
```

The suite has **187 tests**. It runs in about a second without network access, with about 97% line coverage. The integration tests start a local HTTP server that serves images and videos generated at startup with sharp and ffmpeg.

The fixture server also serves failure cases:
- 404, 500, HTML, corrupt bytes and an empty body
- an oversized body and a server that never responds
- a redirect, a redirect loop, and a redirect to a different host
- HLS playlists disguised as MP4s

Each test sends a real request through `app.inject` and checks the output by decoding it with sharp (format, dimensions, pixel colours). The SSRF DNS guard is tested with an injected resolver, so no real DNS is involved.

---

## Security

- **SSRF.** Private, loopback, link-local (cloud metadata), CGNAT, multicast, NAT64 and 6to4 ranges are blocked.
  - The check runs inside the DNS lookup used to open the socket, not as a separate check beforehand, so DNS rebinding can't get around it.
  - IP literals are checked up front, including forms like `[::ffff:127.0.0.1]` and `2130706433`.
  - Every redirect hop is checked again.
  - `ALLOWED_SOURCE_HOSTS` narrows this further to an allow-list.
- **ffmpeg input.** ffmpeg normally guesses the format, and some formats make it open other files. An HLS playlist served as `video.mp4` would make ffmpeg read local files (e.g. `file:///etc/passwd`) or internal URLs, and return their contents as a thumbnail. The service identifies the container from its magic bytes itself, rejects anything that isn't a plain media container, and runs ffmpeg with that demuxer forced and only the `file` protocol allowed. The tests include this attack.
- **Resource limits.**
  - Downloads are capped by `Content-Length` and by counting bytes as they stream in.
  - A 100-megapixel limit protects against decompression bombs.
  - ffmpeg is killed after 30 seconds.
  - Concurrent jobs are capped, with a bounded queue that turns overload into a fast `503`.
- **Abuse.** Optional signed URLs (HMAC-SHA256, compared in constant time) stop anyone else using your compute.

## Implementation notes and trade-offs

- **Why sharp?** It is built on libvips, which is fast and uses little memory. It is the standard choice for image processing in Node.
- **Caching.** The cache is in process and bounded by entry count, total bytes and TTL. Identical requests that arrive while the first is still processing share its result instead of repeating the work (`X-Cache: COALESCED`). Responses carry strong ETags and `Cache-Control`, so a CDN can sit in front. `immutable` is deliberately not set, because the image behind a source URL can change. For more than one instance, swap the LRU for a shared store (Redis/S3) behind the same interface.
- **Video.** The download is written to a temp file instead of piped into ffmpeg, because many MP4s keep their index (`moov` atom) at the end and need seeking. If `time` is past the end of the video, the client gets a 400 that tells them the actual duration.
- **Defaults follow Cloudinary** (`crop=scale`, source format kept), so people who know Cloudinary don't get surprises.
- **Linting.** Biome is used instead of ESLint because `typescript-eslint` doesn't support TypeScript 7 yet.

### Possible next steps

- Path-style URLs (`/image/w_500,h_300,c_fill/https://…`) for full Cloudinary compatibility
- More transforms: `dpr`, blur, sharpen, rotate, watermark
- Rate limiting per client or per API key
- A shared cache and moving processing to worker threads, for horizontal scaling
- Metrics (Prometheus) for latency, cache hit rate and queue depth
- Generating the OpenAPI spec from the zod schemas so it can't drift
