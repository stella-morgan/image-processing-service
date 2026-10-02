export type OutputFormat = 'jpeg' | 'jpg' | 'png' | 'webp' | 'avif' | 'gif' | 'tiff' | 'auto';
export type CropMode = 'scale' | 'fit' | 'limit' | 'fill' | 'pad';
export type Gravity =
  | 'center'
  | 'north'
  | 'south'
  | 'east'
  | 'west'
  | 'northeast'
  | 'northwest'
  | 'southeast'
  | 'southwest'
  | 'auto';

export interface TransformOptions {
  width?: number;
  height?: number;
  format?: OutputFormat;
  quality?: number;
  crop?: CropMode;
  gravity?: Gravity;
  background?: string;
}

export interface ThumbnailOptions extends TransformOptions {
  time?: number;
}

export interface ImageInfo {
  url: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  hasAlpha: boolean;
  pages: number;
  orientation: number | null;
}

export interface RetryOptions {
  attempts: number;
  maxDelayMs?: number;
}

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  signer?: Signer;
  apiKey?: string;
  retry?: RetryOptions;
}

export type Signer = (path: string, params: Record<string, string>) => string;

export interface ApiErrorBody {
  error: { code: string; message: string; details?: { field?: string; message: string }[] };
}

export class ImageServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: { field?: string; message: string }[] = [],
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ImageServiceError';
  }
}

export interface FetchedImage {
  data: ArrayBuffer;
  contentType: string;
  width: number;
  height: number;
}

const RETRYABLE = new Set([429, 503]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createClient({ baseUrl, fetch: fetchImpl = globalThis.fetch, signer, apiKey, retry }: ClientOptions) {
  const base = baseUrl.replace(/\/+$/, '');

  function pathFor(path: string, source: string, options: object = {}, keyInQuery = false): string {
    const params: Record<string, string> = { url: source };
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) params[key] = String(value);
    }
    if (apiKey && keyInQuery) params.api_key = apiKey;
    if (signer) params.signature = signer(path, params);
    return `${path}?${new URLSearchParams(params).toString()}`;
  }

  async function toError(res: Response): Promise<ImageServiceError> {
    const body = (await res.json().catch(() => undefined)) as ApiErrorBody | undefined;
    const retryAfter = Number(res.headers.get('retry-after'));
    return new ImageServiceError(
      res.status,
      body?.error.code ?? 'UNKNOWN',
      body?.error.message ?? `Request failed with HTTP ${res.status}`,
      body?.error.details,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  async function request(path: string): Promise<Response> {
    const headers: Record<string, string> = apiKey ? { 'x-api-key': apiKey } : {};
    const attempts = retry?.attempts ?? 0;
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${base}${path}`, { headers });
      if (res.ok) return res;
      const error = await toError(res);
      if (!RETRYABLE.has(res.status) || attempt >= attempts) throw error;
      const delay = error.retryAfter ? error.retryAfter * 1000 : 2 ** attempt * 500;
      await sleep(Math.min(delay, retry?.maxDelayMs ?? 30_000));
    }
  }

  async function toImage(res: Response): Promise<FetchedImage> {
    return {
      data: await res.arrayBuffer(),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      width: Number(res.headers.get('x-image-width')),
      height: Number(res.headers.get('x-image-height')),
    };
  }

  const client = {
    url(source: string, options: TransformOptions = {}): string {
      return `${base}${pathFor('/process', source, options, true)}`;
    },

    thumbnailUrl(source: string, options: ThumbnailOptions = {}): string {
      return `${base}${pathFor('/video/thumbnail', source, options, true)}`;
    },

    async fetch(source: string, options: TransformOptions = {}): Promise<FetchedImage> {
      return toImage(await request(pathFor('/process', source, options)));
    },

    async thumbnail(source: string, options: ThumbnailOptions = {}): Promise<FetchedImage> {
      return toImage(await request(pathFor('/video/thumbnail', source, options)));
    },

    async info(source: string): Promise<ImageInfo> {
      return (await request(pathFor('/info', source))).json() as Promise<ImageInfo>;
    },
  };
  return client;
}

export type ImageServiceClient = ReturnType<typeof createClient>;
