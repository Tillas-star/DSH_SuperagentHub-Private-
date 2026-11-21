import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/server/errors';
import {
  detectFormatFromHeader,
  detectImage,
  isImageName,
  makeEtag,
  matchesEtag,
  parseRange,
} from '../../src/server/images';
import { writeJpeg, writePng, writeText } from '../support/context';

describe('format detection', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const gif = Buffer.from('GIF89a000000000000', 'ascii');
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WEBP', 'ascii'),
  ]);
  const bmp = Buffer.from('BM000000000000', 'ascii');
  const avif = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from('ftyp', 'ascii'),
    Buffer.from('avif', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('mif1', 'ascii'),
  ]);
  const heic = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from('ftyp', 'ascii'),
    Buffer.from('heic', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('mif1', 'ascii'),
  ]);

  it('recognizes supported formats by magic bytes', () => {
    expect(detectFormatFromHeader(jpeg)).toBe('jpeg');
    expect(detectFormatFromHeader(png)).toBe('png');
    expect(detectFormatFromHeader(gif)).toBe('gif');
    expect(detectFormatFromHeader(webp)).toBe('webp');
    expect(detectFormatFromHeader(bmp)).toBe('bmp');
    expect(detectFormatFromHeader(avif)).toBe('avif');
    expect(detectFormatFromHeader(heic)).toBe('heic');
  });

  it('rejects unknown and scriptable content', () => {
    expect(detectFormatFromHeader(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(detectFormatFromHeader(Buffer.from('not an image at all'))).toBeNull();
  });

  it('recognizes supported extensions case-insensitively', () => {
    expect(isImageName('a.JPG')).toBe(true);
    expect(isImageName('a.heic')).toBe(true);
    expect(isImageName('a.svg')).toBe(false);
    expect(isImageName('a.txt')).toBe(false);
  });
});

describe('detectImage', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfb-images-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('accepts an image whose extension and signature agree', async () => {
    const file = path.join(dir, 'ok.jpg');
    await writeJpeg(file);
    await expect(detectImage(file, 'ok.jpg')).resolves.toBe('jpeg');
  });

  it('rejects text renamed to an image extension', async () => {
    const file = path.join(dir, 'fake.jpg');
    await writeText(file, 'not a jpeg');
    await expect(detectImage(file, 'fake.jpg')).rejects.toMatchObject({
      code: 'unsupported-image',
    });
  });

  it('rejects mismatched signatures and SVG', async () => {
    const pngAsJpg = path.join(dir, 'png-as-jpg.jpg');
    await writePng(pngAsJpg);
    await expect(detectImage(pngAsJpg, 'png-as-jpg.jpg')).rejects.toBeInstanceOf(AppError);

    const svg = path.join(dir, 'vector.svg');
    await writeText(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await expect(detectImage(svg, 'vector.svg')).rejects.toMatchObject({
      code: 'unsupported-image',
    });
  });
});

describe('parseRange', () => {
  it('parses standard, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=0-1000', 100)).toEqual({ start: 0, end: 99 });
  });

  it('returns null without a range and invalid for malformed or unsatisfiable ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,3-4', 100)).toBe('invalid');
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-2', 100)).toBe('invalid');
    expect(parseRange('bytes=-0', 100)).toBe('invalid');
  });
});

describe('ETags', () => {
  it('matches strong, weak and wildcard validators', () => {
    const etag = makeEtag(1234, 5678);
    expect(matchesEtag(etag, etag)).toBe(true);
    expect(matchesEtag(`W/${etag}`, etag)).toBe(true);
    expect(matchesEtag('*', etag)).toBe(true);
    expect(matchesEtag('"other"', etag)).toBe(false);
    expect(matchesEtag(undefined, etag)).toBe(false);
  });
});
