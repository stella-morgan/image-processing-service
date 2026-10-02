import { z } from 'zod';
import { ApiError, type ErrorDetail } from './errors.js';

export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const CROP_MODES = ['scale', 'fit', 'limit', 'fill', 'pad'] as const;
export type CropMode = (typeof CROP_MODES)[number];

export const GRAVITIES = [
  'center',
  'north',
  'south',
  'east',
  'west',
  'northeast',
  'northwest',
  'southeast',
  'southwest',
  'auto',
] as const;
export type Gravity = (typeof GRAVITIES)[number];

export interface ImageTransform {
  width?: number;
  height?: number;
  format?: OutputFormat | 'auto';
  quality?: number;
  crop: CropMode;
  gravity: Gravity;
  background?: string;
}

export interface ProcessParams {
  url: URL;
  transform: ImageTransform;
}

export interface ThumbnailParams extends ProcessParams {
  time: number;
}

const ALIASES: Record<string, string> = {
  w: 'width',
  h: 'height',
  f: 'format',
  q: 'quality',
  c: 'crop',
  g: 'gravity',
  b: 'background',
  t: 'time',
};

const INFO_KEYS = ['url', 'signature'];
const IMAGE_KEYS = [...INFO_KEYS, 'width', 'height', 'format', 'quality', 'crop', 'gravity', 'background'];
const VIDEO_KEYS = [...IMAGE_KEYS, 'time'];

const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function dimension(max: number) {
  return z.coerce
    .number({ message: 'must be a number' })
    .int('must be a whole number')
    .min(1, 'must be at least 1')
    .max(max, `must be at most ${max}`)
    .optional();
}

function buildImageSchema(maxDimension: number) {
  return z.object({
    url: z.string({ message: 'is required' }).min(1, 'is required'),
    width: dimension(maxDimension),
    height: dimension(maxDimension),
    format: z
      .string()
      .toLowerCase()
      .transform((v) => (v === 'jpg' ? 'jpeg' : v))
      .pipe(
        z.enum([...OUTPUT_FORMATS, 'auto'], {
          message: `must be one of: ${[...OUTPUT_FORMATS, 'jpg', 'auto'].join(', ')}`,
        }),
      )
      .optional(),
    quality: z.coerce
      .number({ message: 'must be a number' })
      .int('must be a whole number')
      .min(1, 'must be between 1 and 100')
      .max(100, 'must be between 1 and 100')
      .optional(),
    crop: z
      .string()
      .toLowerCase()
      .pipe(z.enum(CROP_MODES, { message: `must be one of: ${CROP_MODES.join(', ')}` }))
      .default('scale'),
    gravity: z
      .string()
      .toLowerCase()
      .pipe(z.enum(GRAVITIES, { message: `must be one of: ${GRAVITIES.join(', ')}` }))
      .default('center'),
    background: z
      .string()
      .refine(
        (v) => v.toLowerCase() === 'transparent' || HEX_COLOR.test(v),
        'must be a hex color (e.g. ff0000) or "transparent"',
      )
      .optional(),
  });
}

function buildThumbnailSchema(maxDimension: number) {
  return buildImageSchema(maxDimension).extend({
    time: z.coerce
      .number({ message: 'must be a number of seconds' })
      .min(0, 'must be >= 0')
      .max(24 * 3600, 'must be at most 86400 seconds')
      .default(0),
  });
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}

function suggest(key: string, known: string[]): string | undefined {
  let best: { key: string; d: number } | undefined;
  for (const k of known) {
    const d = distance(key.toLowerCase(), k);
    if (d <= 2 && (!best || d < best.d)) best = { key: k, d };
  }
  return best?.key;
}

function normalizeQuery(query: unknown, known: string[]): Record<string, string> {
  const raw = (query ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  const details: ErrorDetail[] = [];

  for (const [rawKey, value] of Object.entries(raw)) {
    const key = ALIASES[rawKey] ?? rawKey;
    if (!known.includes(key)) {
      const hint = suggest(rawKey, known);
      details.push({
        field: rawKey,
        message: `Unknown parameter "${rawKey}".${hint ? ` Did you mean "${hint}"?` : ''}`,
      });
      continue;
    }
    if (Array.isArray(value) || key in out) {
      details.push({ field: key, message: `Parameter "${key}" was provided more than once.` });
      continue;
    }
    out[key] = String(value);
  }

  if (details.length) throw new ApiError('INVALID_PARAMETER', undefined, details);
  return out;
}

function zodToApiError(error: z.ZodError): ApiError {
  const details = error.issues.map((issue) => {
    const field = issue.path.join('.');
    return { field, message: `"${field}" ${issue.message}` };
  });
  return new ApiError('INVALID_PARAMETER', undefined, details);
}

export function parseSourceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError('INVALID_URL', `"url" must be an absolute http(s) URL, received "${value}".`, [
      { field: 'url', message: 'must be an absolute http(s) URL' },
    ]);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError('INVALID_URL', `Unsupported URL protocol "${url.protocol}". Only http and https are allowed.`, [
      { field: 'url', message: 'protocol must be http or https' },
    ]);
  }
  if (url.username || url.password) {
    throw new ApiError('INVALID_URL', 'URLs containing credentials are not allowed.', [
      { field: 'url', message: 'must not contain credentials' },
    ]);
  }
  return url;
}

type ParsedImage = z.infer<ReturnType<typeof buildImageSchema>>;

function toTransform(data: ParsedImage, provided: Set<string>): ImageTransform {
  const fail = (field: string, message: string) => {
    throw new ApiError('INVALID_PARAMETER', undefined, [{ field, message }]);
  };
  const hasWidth = data.width !== undefined;
  const hasHeight = data.height !== undefined;

  if (data.crop !== 'scale' && !hasWidth && !hasHeight) {
    fail('crop', `crop "${data.crop}" requires "width" and/or "height".`);
  }
  if ((data.crop === 'fill' || data.crop === 'pad') && (!hasWidth || !hasHeight)) {
    fail('crop', `crop "${data.crop}" requires both "width" and "height".`);
  }
  if (provided.has('gravity') && data.gravity !== 'center' && data.crop !== 'fill') {
    fail('gravity', '"gravity" only applies to crop=fill.');
  }
  if (provided.has('background') && data.crop !== 'pad' && data.format !== 'jpeg' && data.format !== 'auto') {
    fail('background', '"background" only applies to crop=pad, or to format=jpeg/auto (to flatten transparency).');
  }
  if (provided.has('quality') && data.format === 'gif') {
    fail('quality', '"quality" is not supported for format=gif.');
  }

  return {
    width: data.width,
    height: data.height,
    format: data.format,
    quality: data.quality,
    crop: data.crop,
    gravity: data.gravity,
    background: data.background,
  };
}

export function parseProcessParams(query: unknown, maxDimension: number): ProcessParams {
  const normalized = normalizeQuery(query, IMAGE_KEYS);
  const result = buildImageSchema(maxDimension).safeParse(normalized);
  if (!result.success) throw zodToApiError(result.error);
  const provided = new Set(Object.keys(normalized));
  return { url: parseSourceUrl(result.data.url), transform: toTransform(result.data, provided) };
}

export function parseThumbnailParams(query: unknown, maxDimension: number): ThumbnailParams {
  const normalized = normalizeQuery(query, VIDEO_KEYS);
  const result = buildThumbnailSchema(maxDimension).safeParse(normalized);
  if (!result.success) throw zodToApiError(result.error);
  const { time, ...parsed } = result.data;
  const image = { ...parsed, format: parsed.format ?? 'jpeg' };
  const provided = new Set(Object.keys(normalized));
  return { url: parseSourceUrl(image.url), transform: toTransform(image, provided), time };
}

export function parseInfoParams(query: unknown): URL {
  const normalized = normalizeQuery(query, INFO_KEYS);
  if (!normalized.url) {
    throw new ApiError('INVALID_PARAMETER', undefined, [{ field: 'url', message: '"url" is required' }]);
  }
  return parseSourceUrl(normalized.url);
}
