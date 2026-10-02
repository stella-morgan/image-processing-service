import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/errors.js';
import { parseInfoParams, parseProcessParams, parseThumbnailParams } from '../../src/lib/params.js';

const MAX = 5000;
const URL_ = 'https://example.com/a.jpg';

function errorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected to throw');
}

describe('parseProcessParams', () => {
  it('parses a full set of parameters', () => {
    const p = parseProcessParams(
      { url: URL_, width: '800', height: '600', format: 'webp', quality: '70', crop: 'fill', gravity: 'north' },
      MAX,
    );
    expect(p.url.href).toBe(URL_);
    expect(p.transform).toMatchObject({
      width: 800,
      height: 600,
      format: 'webp',
      quality: 70,
      crop: 'fill',
      gravity: 'north',
    });
  });

  it('applies defaults', () => {
    const p = parseProcessParams({ url: URL_ }, MAX);
    expect(p.transform).toMatchObject({ crop: 'scale', gravity: 'center' });
    expect(p.transform.format).toBeUndefined();
  });

  it('supports Cloudinary-style short aliases', () => {
    const p = parseProcessParams({ url: URL_, w: '100', h: '50', f: 'png', q: '90', c: 'fit' }, MAX);
    expect(p.transform).toMatchObject({ width: 100, height: 50, format: 'png', quality: 90, crop: 'fit' });
  });

  it('normalises jpg to jpeg and is case-insensitive', () => {
    expect(parseProcessParams({ url: URL_, format: 'JPG' }, MAX).transform.format).toBe('jpeg');
    expect(parseProcessParams({ url: URL_, width: '5', crop: 'FIT' }, MAX).transform.crop).toBe('fit');
  });

  it('requires url', () => {
    const err = errorOf(() => parseProcessParams({ width: '100' }, MAX));
    expect(err.code).toBe('INVALID_PARAMETER');
    expect(err.details?.[0]?.field).toBe('url');
  });

  it.each([
    ['not a url', 'INVALID_URL'],
    ['ftp://example.com/a.jpg', 'INVALID_URL'],
    ['file:///etc/passwd', 'INVALID_URL'],
    ['https://user:pass@example.com/a.jpg', 'INVALID_URL'],
  ])('rejects url %s', (url, code) => {
    expect(errorOf(() => parseProcessParams({ url }, MAX)).code).toBe(code);
  });

  it.each([
    [{ width: '0' }, 'width'],
    [{ width: '-5' }, 'width'],
    [{ width: '10.5' }, 'width'],
    [{ width: 'abc' }, 'width'],
    [{ width: '5001' }, 'width'],
    [{ quality: '0' }, 'quality'],
    [{ quality: '101' }, 'quality'],
    [{ format: 'bmp' }, 'format'],
    [{ crop: 'stretch', width: '10' }, 'crop'],
    [{ gravity: 'up' }, 'gravity'],
    [{ background: 'red' }, 'background'],
  ])('rejects invalid %j', (extra, field) => {
    const err = errorOf(() => parseProcessParams({ url: URL_, ...extra }, MAX));
    expect(err.code).toBe('INVALID_PARAMETER');
    expect(err.details?.map((d) => d.field)).toContain(field);
  });

  it('rejects unknown parameters and suggests the closest match', () => {
    const err = errorOf(() => parseProcessParams({ url: URL_, widht: '100' }, MAX));
    expect(err.code).toBe('INVALID_PARAMETER');
    expect(err.details?.[0]?.message).toContain('Did you mean "width"?');
  });

  it('rejects duplicated parameters', () => {
    const err = errorOf(() => parseProcessParams({ url: URL_, width: ['1', '2'] }, MAX));
    expect(err.details?.[0]?.message).toContain('more than once');
  });

  it('rejects the same parameter given via name and alias', () => {
    const err = errorOf(() => parseProcessParams({ url: URL_, width: '1', w: '2' }, MAX));
    expect(err.details?.[0]?.field).toBe('width');
  });

  it('requires dimensions for crop modes other than scale', () => {
    expect(errorOf(() => parseProcessParams({ url: URL_, crop: 'fit' }, MAX)).details?.[0]?.field).toBe('crop');
    expect(
      errorOf(() => parseProcessParams({ url: URL_, crop: 'fill', width: '10' }, MAX)).details?.[0]?.message,
    ).toContain('both');
    expect(errorOf(() => parseProcessParams({ url: URL_, crop: 'pad', height: '10' }, MAX)).code).toBe(
      'INVALID_PARAMETER',
    );
  });

  it('accepts hex and transparent backgrounds', () => {
    const pad = { url: URL_, crop: 'pad', width: '10', height: '10' };
    expect(parseProcessParams({ ...pad, background: 'ff0000' }, MAX).transform.background).toBe('ff0000');
    expect(parseProcessParams({ ...pad, background: '#abc' }, MAX).transform.background).toBe('#abc');
    expect(parseProcessParams({ ...pad, background: 'transparent' }, MAX).transform.background).toBe('transparent');
  });

  it('accepts a signature parameter', () => {
    expect(parseProcessParams({ url: URL_, signature: 'abc' }, MAX).url.href).toBe(URL_);
  });

  describe('rejects options that would have no effect', () => {
    it('gravity without crop=fill', () => {
      const err = errorOf(() => parseProcessParams({ url: URL_, width: '10', gravity: 'north' }, MAX));
      expect(err.details?.[0]).toMatchObject({ field: 'gravity', message: expect.stringContaining('crop=fill') });
    });

    it('still accepts explicitly sent default values, as generated clients and Swagger UI do', () => {
      const p = parseProcessParams({ url: URL_, width: '400', crop: 'scale', gravity: 'center' }, MAX);
      expect(p.transform).toMatchObject({ width: 400, crop: 'scale', gravity: 'center' });
    });

    it('background without crop=pad or a jpeg target', () => {
      const err = errorOf(() => parseProcessParams({ url: URL_, background: 'fff' }, MAX));
      expect(err.details?.[0]?.field).toBe('background');
      expect(parseProcessParams({ url: URL_, format: 'jpeg', background: '000' }, MAX).transform.background).toBe(
        '000',
      );
      expect(parseProcessParams({ url: URL_, format: 'auto', background: '000' }, MAX).transform.background).toBe(
        '000',
      );
    });

    it('quality with gif', () => {
      const err = errorOf(() => parseProcessParams({ url: URL_, format: 'gif', quality: '50' }, MAX));
      expect(err.details?.[0]?.field).toBe('quality');
    });
  });
});

describe('parseInfoParams', () => {
  it('parses url and accepts a signature', () => {
    expect(parseInfoParams({ url: URL_, signature: 'x' }).href).toBe(URL_);
  });

  it('rejects missing url, unknown and transform parameters', () => {
    expect(errorOf(() => parseInfoParams({})).details?.[0]?.field).toBe('url');
    expect(errorOf(() => parseInfoParams({ url: URL_, width: '10' })).details?.[0]?.field).toBe('width');
  });
});

describe('parseThumbnailParams', () => {
  it('parses time and image transforms', () => {
    const p = parseThumbnailParams({ url: URL_, time: '1.5', width: '320' }, MAX);
    expect(p.time).toBe(1.5);
    expect(p.transform.width).toBe(320);
  });

  it('defaults the output format to jpeg', () => {
    expect(parseThumbnailParams({ url: URL_ }, MAX).transform.format).toBe('jpeg');
    expect(parseThumbnailParams({ url: URL_, format: 'webp' }, MAX).transform.format).toBe('webp');
  });

  it('defaults time to 0 and accepts the t alias', () => {
    expect(parseThumbnailParams({ url: URL_ }, MAX).time).toBe(0);
    expect(parseThumbnailParams({ url: URL_, t: '2' }, MAX).time).toBe(2);
  });

  it('rejects negative or non-numeric time', () => {
    expect(errorOf(() => parseThumbnailParams({ url: URL_, time: '-1' }, MAX)).details?.[0]?.field).toBe('time');
    expect(errorOf(() => parseThumbnailParams({ url: URL_, time: 'soon' }, MAX)).details?.[0]?.field).toBe('time');
  });

  it('does not accept time on /process', () => {
    expect(errorOf(() => parseProcessParams({ url: URL_, time: '1' }, MAX)).code).toBe('INVALID_PARAMETER');
  });
});
