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

export const ALIASES: Readonly<Record<string, string>> = {
  w: 'width',
  h: 'height',
  f: 'format',
  q: 'quality',
  c: 'crop',
  g: 'gravity',
  b: 'background',
  t: 'time',
};

export const AUTH_PARAMS = ['signature', 'api_key'] as const;

export const CASE_INSENSITIVE = new Set(['format', 'crop', 'gravity', 'background']);
const FORMAT_VALUES = [...OUTPUT_FORMATS, 'jpg', 'auto'] as const;
const HEX_OR_TRANSPARENT = /^(transparent|#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8}))$/;

const sourceUrl = z
  .string({ message: 'is required' })
  .min(1, 'is required')
  .meta({ description: 'Absolute http(s) URL of the source asset.', format: 'uri' });

function dimension(max: number, description: string) {
  return z.coerce
    .number({ message: 'must be a number' })
    .int('must be a whole number')
    .min(1, 'must be at least 1')
    .max(max, `must be at most ${max}`)
    .optional()
    .meta({ description });
}

function format(description: string) {
  return z.enum(FORMAT_VALUES, { message: `must be one of: ${FORMAT_VALUES.join(', ')}` }).meta({ description });
}

export function imageQuerySchema(maxDimension: number) {
  return z.object({
    url: sourceUrl,
    width: dimension(maxDimension, 'Target width in pixels.'),
    height: dimension(maxDimension, 'Target height in pixels.'),
    format: format(
      'Output format. `auto` picks AVIF, then WebP, then JPEG/PNG from the Accept header. Defaults to the source format.',
    ).optional(),
    quality: z.coerce
      .number({ message: 'must be a number' })
      .int('must be a whole number')
      .min(1, 'must be between 1 and 100')
      .max(100, 'must be between 1 and 100')
      .optional()
      .meta({ description: 'Lossy quality. For PNG it enables palette quantisation. Not supported for gif.' }),
    crop: z
      .enum(CROP_MODES, { message: `must be one of: ${CROP_MODES.join(', ')}` })
      .default('scale')
      .meta({
        description:
          'How the image is fitted into width x height (Cloudinary semantics). `fill` and `pad` require both dimensions.',
      }),
    gravity: z
      .enum(GRAVITIES, { message: `must be one of: ${GRAVITIES.join(', ')}` })
      .default('center')
      .meta({
        description: 'Which part to keep when crop=fill cuts the image. `auto` keeps the most interesting region.',
      }),
    background: z
      .string()
      .regex(HEX_OR_TRANSPARENT, 'must be a hex color (e.g. ff0000) or "transparent"')
      .optional()
      .meta({
        description: 'Hex colour or `transparent`, for crop=pad or flattening transparency into format=jpeg/auto.',
      }),
  });
}

export function thumbnailQuerySchema(maxDimension: number) {
  return imageQuerySchema(maxDimension).extend({
    format: format('Output format. `auto` picks AVIF, then WebP, then JPEG/PNG from the Accept header.').default(
      'jpeg',
    ),
    time: z.coerce
      .number({ message: 'must be a number of seconds' })
      .min(0, 'must be >= 0')
      .max(24 * 3600, 'must be at most 86400 seconds')
      .default(0)
      .meta({ description: 'Timestamp of the frame, in seconds. Decimals are allowed.' }),
  });
}

export const infoQuerySchema = z.object({ url: sourceUrl });

const knownKeys = (schema: z.ZodObject) => [...Object.keys(schema.shape), ...AUTH_PARAMS];

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
    out[key] = CASE_INSENSITIVE.has(key) ? String(value).toLowerCase() : String(value);
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

type ParsedImage = z.infer<ReturnType<typeof imageQuerySchema>>;

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
  if (
    provided.has('background') &&
    data.crop !== 'pad' &&
    data.format !== 'jpeg' &&
    data.format !== 'jpg' &&
    data.format !== 'auto'
  ) {
    fail('background', '"background" only applies to crop=pad, or to format=jpeg/auto (to flatten transparency).');
  }
  if (provided.has('quality') && data.format === 'gif') {
    fail('quality', '"quality" is not supported for format=gif.');
  }

  return {
    width: data.width,
    height: data.height,
    format: data.format === 'jpg' ? 'jpeg' : data.format,
    quality: data.quality,
    crop: data.crop,
    gravity: data.gravity,
    background: data.background,
  };
}

export function parseProcessParams(query: unknown, maxDimension: number): ProcessParams {
  const schema = imageQuerySchema(maxDimension);
  const normalized = normalizeQuery(query, knownKeys(schema));
  const result = schema.safeParse(normalized);
  if (!result.success) throw zodToApiError(result.error);
  const provided = new Set(Object.keys(normalized));
  return { url: parseSourceUrl(result.data.url), transform: toTransform(result.data, provided) };
}

export function parseThumbnailParams(query: unknown, maxDimension: number): ThumbnailParams {
  const schema = thumbnailQuerySchema(maxDimension);
  const normalized = normalizeQuery(query, knownKeys(schema));
  const result = schema.safeParse(normalized);
  if (!result.success) throw zodToApiError(result.error);
  const { time, ...image } = result.data;
  const provided = new Set(Object.keys(normalized));
  return { url: parseSourceUrl(image.url), transform: toTransform(image, provided), time };
}

export function parseInfoParams(query: unknown): URL {
  const normalized = normalizeQuery(query, knownKeys(infoQuerySchema));
  const result = infoQuerySchema.safeParse(normalized);
  if (!result.success) throw zodToApiError(result.error);
  return parseSourceUrl(result.data.url);
}
