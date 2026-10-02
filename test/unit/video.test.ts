import { describe, expect, it } from 'vitest';
import { detectContainer, parseDuration } from '../../src/lib/videoThumbnail.js';
import { maliciousPlaylist } from '../helpers/video.js';

describe('detectContainer', () => {
  const pad = (head: Buffer, size = 400) => Buffer.concat([head, Buffer.alloc(size - head.length)]);

  it.each([
    ['mp4/mov', pad(Buffer.from('\x00\x00\x00\x18ftypisom', 'latin1')), 'mov'],
    ['mkv/webm', pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'matroska'],
    ['avi', pad(Buffer.from('RIFF\x00\x00\x00\x00AVI ', 'latin1')), 'avi'],
    ['flv', pad(Buffer.from('FLV\x01', 'latin1')), 'flv'],
    ['ogg', pad(Buffer.from('OggS', 'latin1')), 'ogg'],
  ])('detects %s', (_name, buf, expected) => {
    expect(detectContainer(buf)).toBe(expected);
  });

  it('detects MPEG-TS by its repeating sync byte', () => {
    const ts = Buffer.alloc(188 * 3);
    for (const i of [0, 188, 376]) ts[i] = 0x47;
    expect(detectContainer(ts)).toBe('mpegts');
  });

  it.each([
    ['an HLS playlist', maliciousPlaylist('file:///etc/passwd')],
    ['an ffconcat list', Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\n")],
    ['HTML', Buffer.from('<html></html>')],
    ['an empty buffer', Buffer.alloc(0)],
  ])('rejects %s', (_name, buf) => {
    expect(detectContainer(buf)).toBeUndefined();
  });
});

describe('parseDuration', () => {
  it('parses ffmpeg duration lines', () => {
    expect(parseDuration('  Duration: 00:01:02.50, start: 0.000000')).toBe(62.5);
    expect(parseDuration('nothing here')).toBeUndefined();
  });
});
