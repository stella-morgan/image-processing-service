import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { ApiError } from './errors.js';

const FFMPEG_TIMEOUT_MS = 30_000;

export type VideoContainer = 'mov' | 'matroska' | 'avi' | 'flv' | 'mpegts' | 'ogg';

// Never let ffmpeg probe the input: HLS/concat playlists would make it open arbitrary local files and URLs.
export function detectContainer(buf: Buffer): VideoContainer | undefined {
  const ascii = (start: number, end: number) => buf.subarray(start, end).toString('latin1');
  if (buf.length >= 12 && ascii(4, 8) === 'ftyp') return 'mov';
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return 'matroska';
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ') return 'avi';
  if (buf.length >= 3 && ascii(0, 3) === 'FLV') return 'flv';
  if (buf.length >= 4 && ascii(0, 4) === 'OggS') return 'ogg';
  if (buf.length > 376 && buf[0] === 0x47 && buf[188] === 0x47 && buf[376] === 0x47) return 'mpegts';
  return undefined;
}

interface FfmpegResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

function runFfmpeg(args: string[]): Promise<FfmpegResult> {
  const bin = ffmpegPath as unknown as string | null;
  if (!bin) throw new ApiError('INTERNAL_ERROR', 'ffmpeg binary is not available on this platform.');

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr, code });
    });
  });
}

export function parseDuration(stderr: string): number | undefined {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// Written to a temp file because MP4s with a trailing moov atom cannot be read from a pipe.
export async function extractFrame(video: Buffer, timeSeconds: number, contentType?: string): Promise<Buffer> {
  const container = detectContainer(video);
  if (!container) {
    throw new ApiError(
      'UNSUPPORTED_MEDIA_TYPE',
      `Source is not a supported video container (MP4/MOV, WebM/MKV, AVI, FLV, Ogg, MPEG-TS)${
        contentType ? `; Content-Type was ${contentType}` : ''
      }.`,
    );
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'thumb-'));
  const input = path.join(dir, 'input');
  try {
    await writeFile(input, video);
    const { stdout, stderr, code } = await runFfmpeg([
      '-hide_banner',
      '-nostdin',
      '-protocol_whitelist',
      'file',
      '-f',
      container,
      '-ss',
      String(timeSeconds),
      '-i',
      input,
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1',
    ]);

    if (stdout.length > 0) return stdout;

    const duration = parseDuration(stderr);
    if (duration !== undefined && timeSeconds >= duration) {
      throw new ApiError(
        'INVALID_PARAMETER',
        `"time" (${timeSeconds}s) is beyond the end of the video (duration ${duration.toFixed(2)}s).`,
        [{ field: 'time', message: `must be less than the video duration (${duration.toFixed(2)}s)` }],
      );
    }
    if (code !== 0 || /Invalid data found|could not find codec|does not contain any stream/i.test(stderr)) {
      throw new ApiError('UNPROCESSABLE_SOURCE', 'The source asset could not be decoded as a video.');
    }
    throw new ApiError('UNPROCESSABLE_SOURCE', 'No frame could be extracted from the video.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
