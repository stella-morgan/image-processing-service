import sharp, { type FitEnum, type Sharp } from 'sharp';
import { ApiError } from './errors.js';
import { type CropMode, type Gravity, type ImageTransform, OUTPUT_FORMATS, type OutputFormat } from './params.js';

const MAX_INPUT_PIXELS = 100_000_000;

export const MIME_TYPES: Record<OutputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  tiff: 'image/tiff',
};

const FIT: Record<CropMode, keyof FitEnum> = {
  scale: 'fill',
  fit: 'inside',
  limit: 'inside',
  fill: 'cover',
  pad: 'contain',
};

const POSITION: Record<Exclude<Gravity, 'auto'>, string> = {
  center: 'centre',
  north: 'north',
  south: 'south',
  east: 'east',
  west: 'west',
  northeast: 'northeast',
  northwest: 'northwest',
  southeast: 'southeast',
  southwest: 'southwest',
};

export interface ProcessedImage {
  buffer: Buffer;
  format: OutputFormat;
  contentType: string;
  width: number;
  height: number;
}

export interface ProcessOptions {
  accept?: string;
  sourceContentType?: string;
}

export function preferredModernFormat(accept: string | undefined): 'avif' | 'webp' | undefined {
  const a = accept?.toLowerCase() ?? '';
  if (a.includes('image/avif')) return 'avif';
  if (a.includes('image/webp')) return 'webp';
  return undefined;
}

export function negotiateFormat(accept: string | undefined, hasAlpha: boolean): OutputFormat {
  return preferredModernFormat(accept) ?? (hasAlpha ? 'png' : 'jpeg');
}

function resolveFormat(
  requested: ImageTransform['format'],
  inputFormat: string | undefined,
  hasAlpha: boolean,
  accept: string | undefined,
): OutputFormat {
  if (requested === 'auto') return negotiateFormat(accept, hasAlpha);
  if (requested) return requested;
  if (inputFormat && (OUTPUT_FORMATS as readonly string[]).includes(inputFormat)) return inputFormat as OutputFormat;
  return hasAlpha ? 'png' : 'jpeg';
}

function parseBackground(value: string | undefined, format: OutputFormat) {
  if (!value) {
    return format === 'jpeg' ? { r: 255, g: 255, b: 255, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 };
  }
  if (value === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 };
  return value.startsWith('#') ? value : `#${value}`;
}

function encode(pipeline: Sharp, format: OutputFormat, quality: number | undefined): Sharp {
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg({ quality: quality ?? 80, mozjpeg: true });
    case 'png':
      return pipeline.png(quality ? { quality, palette: true } : { compressionLevel: 9 });
    case 'webp':
      return pipeline.webp({ quality: quality ?? 80 });
    case 'avif':
      return pipeline.avif({ quality: quality ?? 50 });
    case 'gif':
      return pipeline.gif();
    case 'tiff':
      return pipeline.tiff({ quality: quality ?? 80 });
  }
}

export async function processImage(
  input: Buffer,
  transform: ImageTransform,
  options: ProcessOptions = {},
): Promise<ProcessedImage> {
  const metadata = await readMetadata(input, options.sourceContentType);
  const hasAlpha = Boolean(metadata.hasAlpha);
  const format = resolveFormat(transform.format, metadata.format, hasAlpha, options.accept);

  const animated = (metadata.pages ?? 1) > 1 && (format === 'gif' || format === 'webp');
  let pipeline = sharp(input, { animated, limitInputPixels: MAX_INPUT_PIXELS }).rotate();

  if (transform.width !== undefined || transform.height !== undefined) {
    // sharp's `fill` would stretch the single given axis; keep the aspect ratio instead.
    const singleDimension = transform.width === undefined || transform.height === undefined;
    pipeline = pipeline.resize({
      width: transform.width,
      height: transform.height,
      fit: singleDimension && transform.crop === 'scale' ? 'inside' : FIT[transform.crop],
      position: transform.gravity === 'auto' ? sharp.strategy.attention : POSITION[transform.gravity],
      background: parseBackground(transform.background, format),
      withoutEnlargement: transform.crop === 'limit',
    });
  }

  if (format === 'jpeg' && hasAlpha) {
    pipeline = pipeline.flatten({ background: parseBackground(transform.background, 'jpeg') });
  }

  try {
    const { data, info } = await encode(pipeline, format, transform.quality).toBuffer({ resolveWithObject: true });
    return {
      buffer: data,
      format,
      contentType: MIME_TYPES[format],
      width: info.width,
      height: info.pageHeight ?? info.height,
    };
  } catch (err) {
    throw new ApiError('UNPROCESSABLE_SOURCE', `Failed to process image: ${(err as Error).message}`);
  }
}

async function readMetadata(input: Buffer, contentType: string | undefined) {
  if (input.length === 0) throw new ApiError('UNPROCESSABLE_SOURCE', 'The source asset is empty.');
  try {
    const metadata = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!metadata.format) throw new Error('unknown format');
    return metadata;
  } catch (err) {
    const message = (err as Error).message;
    if (/pixel limit/i.test(message)) {
      throw new ApiError('SOURCE_TOO_LARGE', `Source image exceeds the maximum of ${MAX_INPUT_PIXELS} pixels.`);
    }
    if (contentType && !contentType.startsWith('image/')) {
      throw new ApiError('UNSUPPORTED_MEDIA_TYPE', `Source is not an image (Content-Type: ${contentType}).`);
    }
    throw new ApiError('UNPROCESSABLE_SOURCE', 'The source asset could not be decoded as an image.');
  }
}
