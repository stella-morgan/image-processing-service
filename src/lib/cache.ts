export interface LruCacheOptions<V> {
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  sizeOf: (value: V) => number;
  now?: () => number;
}

export class LruCache<V> {
  private readonly entries = new Map<string, { value: V; size: number; expiresAt: number }>();
  private totalBytes = 0;
  private readonly now: () => number;

  constructor(private readonly options: LruCacheOptions<V>) {
    this.now = options.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    const { maxEntries, maxBytes, ttlMs } = this.options;
    const size = this.options.sizeOf(value);
    if (maxEntries === 0 || ttlMs === 0 || size > maxBytes) return;

    this.delete(key);
    this.entries.set(key, { value, size, expiresAt: this.now() + ttlMs });
    this.totalBytes += size;

    while (this.entries.size > maxEntries || this.totalBytes > maxBytes) {
      this.delete(this.entries.keys().next().value as string);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.totalBytes -= entry.size;
    this.entries.delete(key);
  }
}
