import { describe, expect, it } from 'vitest';
import { LruCache } from '../../src/lib/cache.js';
import { ApiError } from '../../src/lib/errors.js';
import { negotiateFormat } from '../../src/lib/imageProcessor.js';
import { ConcurrencyLimiter } from '../../src/lib/limiter.js';
import { etagMatches } from '../../src/routes/respond.js';

function cache(overrides: Partial<ConstructorParameters<typeof LruCache<string>>[0]> = {}) {
  return new LruCache<string>({ maxEntries: 10, maxBytes: 1000, ttlMs: 1000, sizeOf: (v) => v.length, ...overrides });
}

describe('LruCache', () => {
  it('evicts the least recently used entry when over the entry limit', () => {
    const c = cache({ maxEntries: 2 });
    c.set('a', '1');
    c.set('b', '2');
    c.get('a');
    c.set('c', '3');
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe('1');
    expect(c.get('c')).toBe('3');
  });

  it('evicts by total size', () => {
    const c = cache({ maxBytes: 10 });
    c.set('a', 'xxxxxx');
    c.set('b', 'yyyy');
    expect(c.bytes).toBe(10);
    c.set('c', 'zz');
    expect(c.get('a')).toBeUndefined();
    expect(c.bytes).toBe(6);
  });

  it('never stores a single value larger than the byte budget', () => {
    const c = cache({ maxBytes: 3 });
    c.set('a', 'toolarge');
    expect(c.size).toBe(0);
  });

  it('keeps byte accounting correct when a key is overwritten', () => {
    const c = cache();
    c.set('a', 'xxxx');
    c.set('a', 'yy');
    expect(c.bytes).toBe(2);
    expect(c.size).toBe(1);
  });

  it('expires entries after the TTL', () => {
    let now = 0;
    const c = cache({ ttlMs: 100, now: () => now });
    c.set('a', '1');
    now = 99;
    expect(c.get('a')).toBe('1');
    now = 200;
    expect(c.get('a')).toBeUndefined();
    expect(c.bytes).toBe(0);
  });

  it('is disabled when maxEntries or ttl is 0', () => {
    for (const c of [cache({ maxEntries: 0 }), cache({ ttlMs: 0 })]) {
      c.set('a', '1');
      expect(c.size).toBe(0);
    }
  });
});

describe('ConcurrencyLimiter', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('runs at most maxConcurrent jobs and queues the rest in order', async () => {
    const limiter = new ConcurrencyLimiter(2, 10);
    const gates = [deferred(), deferred(), deferred()];
    const order: number[] = [];
    const jobs = gates.map((g, i) =>
      limiter.run(async () => {
        order.push(i);
        await g.promise;
      }),
    );

    await Promise.resolve();
    expect(limiter.stats).toEqual({ active: 2, queued: 1 });
    expect(order).toEqual([0, 1]);

    gates[0]!.resolve();
    await jobs[0];
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2]);
    expect(limiter.stats).toEqual({ active: 2, queued: 0 });

    gates[1]!.resolve();
    gates[2]!.resolve();
    await Promise.all(jobs);
    expect(limiter.stats).toEqual({ active: 0, queued: 0 });
  });

  it('rejects with SERVER_BUSY when the queue is full', async () => {
    const limiter = new ConcurrencyLimiter(1, 0);
    const gate = deferred();
    const first = limiter.run(() => gate.promise);
    const err = await limiter.run(async () => 'never').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('SERVER_BUSY');
    gate.resolve();
    await first;
  });

  it('releases the slot when a job throws', async () => {
    const limiter = new ConcurrencyLimiter(1, 0);
    await expect(limiter.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limiter.run(async () => 'ok')).toBe('ok');
  });
});

describe('etagMatches', () => {
  const etag = '"abc"';
  it.each([
    ['"abc"', true],
    ['W/"abc"', true],
    ['"zzz", "abc"', true],
    ['*', true],
    ['"zzz"', false],
    [undefined, false],
  ])('%s -> %s', (header, expected) => {
    expect(etagMatches(header, etag)).toBe(expected);
  });
});

describe('negotiateFormat', () => {
  it('prefers avif, then webp, then jpeg/png', () => {
    expect(negotiateFormat('image/avif,image/webp,*/*', false)).toBe('avif');
    expect(negotiateFormat('image/webp,*/*', false)).toBe('webp');
    expect(negotiateFormat('*/*', false)).toBe('jpeg');
    expect(negotiateFormat(undefined, true)).toBe('png');
  });
});
