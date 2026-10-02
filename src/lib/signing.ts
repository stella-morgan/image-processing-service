import { createHmac, timingSafeEqual } from 'node:crypto';

type QueryValue = string | number | boolean | undefined | readonly (string | number | boolean)[];

export function canonicalize(path: string, params: Record<string, QueryValue | unknown>): string {
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) {
    if (key === 'signature' || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) pairs.push([key, String(v)]);
  }
  pairs.sort(([ka, va], [kb, vb]) => (ka === kb ? (va < vb ? -1 : va > vb ? 1 : 0) : ka < kb ? -1 : 1));
  return `${path}?${new URLSearchParams(pairs).toString()}`;
}

export function sign(secret: string, path: string, params: Record<string, QueryValue | unknown>): string {
  return createHmac('sha256', secret).update(canonicalize(path, params)).digest('base64url');
}

export function verifySignature(secret: string, path: string, params: Record<string, unknown>): boolean {
  const provided = params.signature;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expected = Buffer.from(sign(secret, path, params));
  const actual = Buffer.from(provided);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
