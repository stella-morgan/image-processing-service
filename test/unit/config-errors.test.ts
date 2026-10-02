import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ApiError } from '../../src/lib/errors.js';

describe('loadConfig', () => {
  it('uses defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ port: 3000, allowPrivateNetworks: false, allowedSourceHosts: [], maxQueuedJobs: 100 });
    expect(c.signingSecret).toBeUndefined();
    expect(c.maxConcurrentJobs).toBeGreaterThan(0);
  });

  it('parses env values', () => {
    const c = loadConfig({
      PORT: '8080',
      ALLOW_PRIVATE_NETWORKS: 'true',
      MAX_DIMENSION: '100',
      ALLOWED_SOURCE_HOSTS: ' images.example.com, *.CDN.example.com ,',
      SIGNING_SECRET: 'a-very-long-secret-value',
    });
    expect(c).toMatchObject({
      port: 8080,
      allowPrivateNetworks: true,
      maxDimension: 100,
      allowedSourceHosts: ['images.example.com', '*.cdn.example.com'],
      signingSecret: 'a-very-long-secret-value',
    });
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ SIGNING_SECRET: '', PORT: '' })).toMatchObject({ port: 3000, signingSecret: undefined });
  });

  it('throws a readable error on invalid values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid configuration: PORT/);
    expect(() => loadConfig({ SIGNING_SECRET: 'short' })).toThrow(/SIGNING_SECRET: must be at least 16/);
  });
});

describe('ApiError', () => {
  it('serialises to a stable envelope', () => {
    const err = new ApiError('INVALID_PARAMETER', 'bad', [{ field: 'width', message: 'nope' }]);
    expect(err.status).toBe(400);
    expect(err.toJSON()).toEqual({
      error: { code: 'INVALID_PARAMETER', message: 'bad', details: [{ field: 'width', message: 'nope' }] },
    });
  });

  it('falls back to the catalogue message and omits empty details', () => {
    const err = new ApiError('SERVER_BUSY');
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/capacity/);
    expect(err.toJSON().error).not.toHaveProperty('details');
  });
});
