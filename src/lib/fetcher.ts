import dns from 'node:dns';
import net from 'node:net';
import { Agent, type Dispatcher, fetch } from 'undici';
import { ApiError } from './errors.js';

const MAX_REDIRECTS = 5;

const blockList = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockList.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockList.addSubnet(addr, prefix, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blockList.check(mapped[1]!, 'ipv4');
    return blockList.check(address, 'ipv6');
  }
  return blockList.check(address, 'ipv4');
}

class BlockedAddressError extends Error {
  readonly code = 'EBLOCKED';
}

type Resolver = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

// Checked at connect time rather than before the request, so DNS rebinding cannot bypass it.
export function createSafeLookup(resolve: Resolver = dns.lookup as unknown as Resolver): net.LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as dns.LookupAddress[];
      const allowed = list.filter((a) => !isBlockedAddress(a.address));
      if (allowed.length === 0) {
        return callback(new BlockedAddressError(`Host "${hostname}" resolves to a private address`), '', 0);
      }
      if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, allowed);
      callback(null, allowed[0]!.address, allowed[0]!.family);
    });
  };
}

export function hostMatches(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return patterns.some((p) =>
    p.startsWith('*.') ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p,
  );
}

export interface FetchedAsset {
  body: Buffer;
  contentType: string | undefined;
  finalUrl: URL;
}

export interface FetchOptions {
  maxBytes: number;
  timeoutMs: number;
  allowPrivateNetworks: boolean;
  allowedHosts?: readonly string[];
  resolve?: Resolver;
}

export class SourceFetcher {
  private readonly dispatcher: Dispatcher;

  constructor(private readonly options: FetchOptions) {
    this.dispatcher = new Agent({
      connect: options.allowPrivateNetworks ? {} : { lookup: createSafeLookup(options.resolve) },
    });
  }

  async fetch(url: URL, overrides: Partial<Pick<FetchOptions, 'maxBytes'>> = {}): Promise<FetchedAsset> {
    const maxBytes = overrides.maxBytes ?? this.options.maxBytes;
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    let current = url;

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        this.assertAllowedHost(current);
        const res = await fetch(current, {
          dispatcher: this.dispatcher,
          redirect: 'manual',
          signal,
          headers: { 'user-agent': 'image-processing-service/0.1', accept: 'image/*,video/*;q=0.9,*/*;q=0.5' },
        });

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          await res.body?.cancel();
          if (!location)
            throw new ApiError(
              'SOURCE_FETCH_FAILED',
              `Source responded with redirect ${res.status} but no Location header.`,
            );
          const next = new URL(location, current);
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            throw new ApiError('FORBIDDEN_URL', `Source redirected to unsupported protocol "${next.protocol}".`);
          }
          current = next;
          continue;
        }

        if (res.status === 404 || res.status === 410) {
          await res.body?.cancel();
          throw new ApiError('SOURCE_NOT_FOUND', `Source asset not found (upstream responded ${res.status}).`);
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new ApiError('SOURCE_FETCH_FAILED', `Source responded with HTTP ${res.status}.`);
        }

        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
          await res.body?.cancel();
          throw tooLarge(maxBytes);
        }

        const body = await readLimited(res.body, maxBytes);
        return { body, contentType: res.headers.get('content-type') ?? undefined, finalUrl: current };
      }
      throw new ApiError('SOURCE_FETCH_FAILED', `Too many redirects (more than ${MAX_REDIRECTS}).`);
    } catch (err) {
      throw mapFetchError(err, signal);
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  private assertAllowedHost(url: URL): void {
    const allowed = this.options.allowedHosts ?? [];
    if (allowed.length > 0 && !hostMatches(url.hostname, allowed)) {
      throw new ApiError('FORBIDDEN_URL', `Host "${url.hostname}" is not in the list of allowed source hosts.`);
    }
    if (this.options.allowPrivateNetworks) return;
    // IP literals skip DNS lookup, so they are checked here.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || isBlockedAddress(host)) {
      throw new ApiError('FORBIDDEN_URL', `Fetching from "${url.hostname}" is not allowed.`);
    }
  }
}

function tooLarge(maxBytes: number): ApiError {
  return new ApiError('SOURCE_TOO_LARGE', `Source asset exceeds the maximum allowed size of ${maxBytes} bytes.`);
}

async function readLimited(body: AsyncIterable<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw tooLarge(maxBytes);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function mapFetchError(err: unknown, signal: AbortSignal): ApiError {
  if (err instanceof ApiError) return err;
  if (signal.aborted) return new ApiError('SOURCE_TIMEOUT');

  type ErrLike = { code?: string; message?: string };
  const cause = (err as { cause?: ErrLike })?.cause ?? (err as ErrLike);
  switch (cause?.code) {
    case 'EBLOCKED':
      return new ApiError('FORBIDDEN_URL', cause.message);
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new ApiError('SOURCE_FETCH_FAILED', 'Could not resolve the source host.');
    case 'ECONNREFUSED':
      return new ApiError('SOURCE_FETCH_FAILED', 'Connection to the source host was refused.');
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return new ApiError('SOURCE_TIMEOUT');
    default:
      return new ApiError('SOURCE_FETCH_FAILED');
  }
}
