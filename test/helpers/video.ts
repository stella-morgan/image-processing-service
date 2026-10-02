import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const run = promisify(execFile);

export async function makeVideo(container: 'mp4' | 'webm' = 'mp4'): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fixture-'));
  const out = path.join(dir, `video.${container}`);
  const codec = container === 'mp4' ? ['-pix_fmt', 'yuv420p', '-movflags', '+faststart'] : ['-c:v', 'libvpx-vp9'];
  try {
    await run(ffmpegPath as unknown as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=3:size=320x240:rate=10',
      ...codec,
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function maliciousPlaylist(target: string): Buffer {
  return Buffer.from(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${target}\n#EXT-X-ENDLIST\n`);
}
