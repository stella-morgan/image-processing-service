import { createHash } from 'node:crypto';

export interface ApiKeyEntry {
  name: string;
  key: string;
  limit?: number;
}

export interface ApiClient {
  name: string;
  limit?: number;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const KEY = /^[\x21-\x7e]{16,256}$/;

export function parseApiKeys(raw: string): ApiKeyEntry[] {
  const entries: ApiKeyEntry[] = [];
  const names = new Set<string>();
  const keys = new Set<string>();

  for (const item of raw.split(',').map((s) => s.trim())) {
    if (!item) continue;
    const [name, key, limit, ...rest] = item.split(':');
    if (!name || !key || rest.length > 0) {
      throw new Error(`entry "${item.slice(0, 20)}…" must be name:key or name:key:limit`);
    }
    if (!NAME.test(name)) throw new Error(`name "${name}" must be alphanumeric (with - or _), up to 64 characters`);
    if (!KEY.test(key)) throw new Error(`key for "${name}" must be 16-256 printable characters without spaces or ":"`);
    if (names.has(name)) throw new Error(`name "${name}" is used more than once`);
    if (keys.has(key)) throw new Error(`the key for "${name}" is already assigned to another client`);

    let parsedLimit: number | undefined;
    if (limit !== undefined) {
      parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        throw new Error(`limit for "${name}" must be a positive integer`);
      }
    }
    names.add(name);
    keys.add(key);
    entries.push({ name, key, limit: parsedLimit });
  }
  return entries;
}

const digest = (key: string) => createHash('sha256').update(key).digest('base64');

// Keys are looked up by SHA-256 digest, so lookup timing reveals nothing about valid keys.
export class ApiKeyRegistry {
  private readonly clients = new Map<string, ApiClient>();

  constructor(entries: readonly ApiKeyEntry[]) {
    for (const { name, key, limit } of entries) this.clients.set(digest(key), { name, limit });
  }

  lookup(key: string): ApiClient | undefined {
    return this.clients.get(digest(key));
  }
}

export function redactSecrets(url: string): string {
  return url.replace(/([?&](?:api_key|signature)=)[^&#]*/gi, '$1[redacted]');
}
