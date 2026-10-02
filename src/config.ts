import os from 'node:os';
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const list = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MAX_IMAGE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(20 * 1024 * 1024),
  MAX_VIDEO_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  MAX_DIMENSION: z.coerce.number().int().positive().default(5000),
  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  CACHE_MAX_ENTRIES: z.coerce.number().int().nonnegative().default(500),
  CACHE_MAX_BYTES: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(100 * 1024 * 1024),
  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(3600),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(os.availableParallelism()),
  MAX_QUEUED_JOBS: z.coerce.number().int().nonnegative().default(100),
  SIGNING_SECRET: z.string().min(16, 'must be at least 16 characters').optional(),
  ALLOWED_SOURCE_HOSTS: list.default([]),
  ALLOW_PRIVATE_NETWORKS: bool.default(false),
});

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  maxImageBytes: number;
  maxVideoBytes: number;
  maxDimension: number;
  fetchTimeoutMs: number;
  cacheMaxEntries: number;
  cacheMaxBytes: number;
  cacheTtlSeconds: number;
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
  signingSecret?: string;
  allowedSourceHosts: string[];
  allowPrivateNetworks: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    maxImageBytes: e.MAX_IMAGE_BYTES,
    maxVideoBytes: e.MAX_VIDEO_BYTES,
    maxDimension: e.MAX_DIMENSION,
    fetchTimeoutMs: e.FETCH_TIMEOUT_MS,
    cacheMaxEntries: e.CACHE_MAX_ENTRIES,
    cacheMaxBytes: e.CACHE_MAX_BYTES,
    cacheTtlSeconds: e.CACHE_TTL_SECONDS,
    maxConcurrentJobs: e.MAX_CONCURRENT_JOBS,
    maxQueuedJobs: e.MAX_QUEUED_JOBS,
    signingSecret: e.SIGNING_SECRET,
    allowedSourceHosts: e.ALLOWED_SOURCE_HOSTS,
    allowPrivateNetworks: e.ALLOW_PRIVATE_NETWORKS,
  };
}
