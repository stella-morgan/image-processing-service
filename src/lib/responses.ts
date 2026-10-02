import { z } from 'zod';

export const ImageInfoSchema = z.object({
  url: z.string().meta({ description: 'Final URL of the source, after redirects.' }),
  format: z.string().meta({ description: 'Detected image format, e.g. jpeg or png.' }),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative().meta({ description: 'Height of one frame for animated images.' }),
  bytes: z.number().int().nonnegative().meta({ description: 'Size of the source in bytes.' }),
  hasAlpha: z.boolean(),
  pages: z.number().int().nonnegative().meta({ description: 'Number of frames; 1 unless animated.' }),
  orientation: z.number().int().nullable().meta({ description: 'EXIF orientation, if present.' }),
});

export type ImageInfo = z.infer<typeof ImageInfoSchema>;

export const HealthSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().int().nonnegative(),
  jobs: z.object({
    active: z.number().int().nonnegative().meta({ description: 'Fetch + transform jobs running now.' }),
    queued: z.number().int().nonnegative().meta({ description: 'Jobs waiting for a free slot.' }),
  }),
  rateLimit: z.object({
    enabled: z.boolean(),
    store: z.enum(['memory', 'redis']),
    connected: z
      .boolean()
      .meta({ description: 'False while the Redis store is unreachable; requests are then not limited.' }),
  }),
});

export type Health = z.infer<typeof HealthSchema>;
