import { promises as fs, createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { AppError } from './errors';

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'avif' | 'heic';

const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
};

const EXTENSION_FORMAT: Record<string, ImageFormat> = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.jfif': 'jpeg',
  '.png': 'png',
  '.gif': 'gif',
  '.webp': 'webp',
  '.bmp': 'bmp',
  '.avif': 'avif',
  '.heic': 'heic',
  '.heif': 'heic',
};

export function extensionOf(name: string): string {
  return name.slice(name.lastIndexOf('.')).toLowerCase();
}

export function isImageName(name: string): boolean {
  return extensionOf(name) in EXTENSION_FORMAT;
}

export function imageMime(format: ImageFormat): string {
  return MIME_BY_FORMAT[format];
}

export function isHeic(format: ImageFormat): boolean {
  return format === 'heic';
}

/**
 * Identify an image by both extension and file signature. Both must agree:
 * a text file renamed to .jpg, or an SVG, is rejected.
 */
export async function detectImage(absPath: string, name: string): Promise<ImageFormat> {
  const expected = EXTENSION_FORMAT[extensionOf(name)];
  if (!expected) throw new AppError('unsupported-image');

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch {
    throw new AppError('not-found');
  }
  const header = Buffer.alloc(64);
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(header, 0, header.length, 0));
  } finally {
    await handle.close();
  }
  if (bytesRead < 12) throw new AppError('unsupported-image');

  const detected = detectFormatFromHeader(header.subarray(0, bytesRead));
  if (!detected || detected !== expected) throw new AppError('unsupported-image');
  return detected;
}

export function detectFormatFromHeader(header: Buffer): ImageFormat | null {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'jpeg';
  }
  if (
    header.length >= 8 &&
    header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (header.length >= 6) {
    const gif = header.subarray(0, 6).toString('ascii');
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  }
  if (header.length >= 2 && header[0] === 0x42 && header[1] === 0x4d) return 'bmp';
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brands = collectIsoBrands(header);
    if (brands.some((brand) => brand === 'avif' || brand === 'avis')) return 'avif';
    if (
      brands.some((brand) =>
        ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand),
      )
    ) {
      return 'heic';
    }
  }
  return null;
}

function collectIsoBrands(header: Buffer): string[] {
  const brands: string[] = [];
  const major = header.subarray(8, 12).toString('ascii');
  if (major) brands.push(major);
  // Compatible brands list starts at byte 16 after minor_version at 12..16.
  for (let offset = 16; offset + 4 <= header.length; offset += 4) {
    const brand = header.subarray(offset, offset + 4).toString('ascii');
    if (brand) brands.push(brand);
  }
  return brands;
}

export function makeEtag(mtimeMs: number, size: number, variant = 'o'): string {
  return `"${mtimeMs.toString(16)}-${size.toString(16)}-${variant}"`;
}

export interface StreamImageOptions {
  /** For HEIC/HEIF, return a browser-friendly JPEG preview. */
  preview?: boolean;
}

export async function sendImage(
  request: FastifyRequest,
  reply: FastifyReply,
  absPath: string,
  name: string,
  options: StreamImageOptions = {},
): Promise<FastifyReply> {
  const format = await detectImage(absPath, name);
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    throw new AppError('not-found');
  }

  if (options.preview && isHeic(format)) {
    await sendHeicPreview(reply, absPath, stat.mtimeMs, stat.size);
    return reply;
  }

  const etag = makeEtag(stat.mtimeMs, stat.size, 'o');
  const cacheControl = 'private, max-age=86400';
  if (matchesEtag(request.headers['if-none-match'], etag)) {
    reply.code(304).header('ETag', etag).header('Cache-Control', cacheControl).send();
    return reply;
  }

  const range = parseRange(request.headers.range, stat.size);
  if (range === 'invalid') {
    reply
      .code(416)
      .header('Content-Range', `bytes */${stat.size}`)
      .header('Accept-Ranges', 'bytes')
      .send();
    return reply;
  }

  const mime = imageMime(format);
  const baseHeaders: Record<string, string | number> = {
    'Content-Type': mime,
    'Cache-Control': cacheControl,
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };

  if (range) {
    const length = range.end - range.start + 1;
    reply
      .code(206)
      .headers({
        ...baseHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        'Content-Length': length,
      })
      .send(createReadStream(absPath, { start: range.start, end: range.end }));
    return reply;
  }

  reply
    .headers({ ...baseHeaders, 'Content-Length': stat.size })
    .send(createReadStream(absPath));
  return reply;
}

async function sendHeicPreview(
  reply: FastifyReply,
  absPath: string,
  mtimeMs: number,
  size: number,
): Promise<void> {
  const etag = makeEtag(mtimeMs, size, 'p');
  if (matchesEtag(reply.request.headers['if-none-match'], etag)) {
    reply.code(304).header('ETag', etag).send();
    return;
  }
  let output: Buffer;
  try {
    output = await sharp(absPath, { limitInputPixels: 100_000_000, failOn: 'error' })
      .rotate()
      .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch {
    throw new AppError('unsupported-image');
  }
  reply
    .headers({
      'Content-Type': 'image/jpeg',
      'Content-Length': output.length,
      'Cache-Control': 'private, max-age=86400',
      ETag: etag,
    })
    .send(output);
}

export function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value.trim() === '*') return true;
  return value
    .split(',')
    .map((part) => part.trim().replace(/^W\//, ''))
    .includes(etag);
}

export type ParsedRange = { start: number; end: number } | null | 'invalid';

export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (!header) return null;
  const value = header.trim();
  if (!value.startsWith('bytes=')) return 'invalid';
  const spec = value.slice('bytes='.length);
  if (!spec || spec.includes(',')) return 'invalid';
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return 'invalid';
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return 'invalid';

  let start: number;
  let end: number;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    if (!Number.isInteger(start) || start < 0 || start >= size) return 'invalid';
    if (!endRaw) {
      end = size - 1;
    } else {
      end = Number(endRaw);
      if (!Number.isInteger(end) || end < start) return 'invalid';
      end = Math.min(end, size - 1);
    }
  }
  return { start, end };
}
