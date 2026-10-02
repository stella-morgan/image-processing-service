import { describe, expect, it } from 'vitest';
import { canonicalize, sign, verifySignature } from '../../src/lib/signing.js';

const SECRET = 'test-secret-0123456789';

describe('canonicalize', () => {
  it('sorts parameters, ignores signature and includes the path', () => {
    expect(canonicalize('/process', { width: '5', url: 'https://a.test/x.jpg', signature: 'zzz' })).toBe(
      '/process?url=https%3A%2F%2Fa.test%2Fx.jpg&width=5',
    );
  });

  it('is independent of parameter order', () => {
    expect(canonicalize('/p', { b: '2', a: '1' })).toBe(canonicalize('/p', { a: '1', b: '2' }));
  });

  it('expands repeated parameters deterministically', () => {
    expect(canonicalize('/p', { a: ['2', '1'] })).toBe('/p?a=1&a=2');
  });
});

describe('verifySignature', () => {
  const params = { url: 'https://a.test/x.jpg', width: '500' };
  const signature = sign(SECRET, '/process', params);

  it('accepts a valid signature', () => {
    expect(verifySignature(SECRET, '/process', { ...params, signature })).toBe(true);
  });

  it.each([
    ['missing', { ...params }],
    ['empty', { ...params, signature: '' }],
    ['tampered params', { ...params, width: '5000', signature }],
    ['wrong length', { ...params, signature: 'abc' }],
  ])('rejects %s', (_name, query) => {
    expect(verifySignature(SECRET, '/process', query)).toBe(false);
  });

  it('rejects a signature issued for another path or secret', () => {
    expect(verifySignature(SECRET, '/info', { ...params, signature })).toBe(false);
    expect(verifySignature('another-secret-012345', '/process', { ...params, signature })).toBe(false);
  });
});
