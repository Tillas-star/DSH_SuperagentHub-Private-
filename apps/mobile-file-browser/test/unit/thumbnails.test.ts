import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RootConfig } from '../../src/server/config';
import { PathGuard } from '../../src/server/paths';
import { ThumbnailService } from '../../src/server/thumbnails';
import { writeJpeg, writeText } from '../support/context';

describe('ThumbnailService', () => {
  let baseDir: string;
  let rootDir: string;
  let cacheDir: string;
  let root: RootConfig;
  let guard: PathGuard;
  let service: ThumbnailService;

  beforeAll(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfb-thumbs-'));
    rootDir = path.join(baseDir, 'root');
    cacheDir = path.join(baseDir, 'cache');
    await fs.mkdir(rootDir, { recursive: true });
    await writeJpeg(path.join(rootDir, 'photo.jpg'), { width: 400, height: 300 });
    await writeJpeg(path.join(rootDir, 'small.jpg'), { width: 32, height: 20 });
    await writeText(path.join(rootDir, 'fake.jpg'), 'not an image');
    root = {
      id: 'pics',
      name: '图片',
      path: rootDir,
      realPath: await fs.realpath(rootDir),
    };
    guard = new PathGuard([root]);
    service = new ThumbnailService({
      guard,
      cacheDir,
      maxWidth: 128,
      maxImagePixels: 100_000_000,
      maxCacheBytes: 1024 * 1024,
      concurrency: 2,
    });
  });

  afterAll(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('generates a bounded WebP thumbnail and reuses its cache', async () => {
    const first = await service.get('pics', 'photo.jpg');
    expect(first.width).toBe(128);
    const stat = await fs.stat(first.file);
    expect(stat.size).toBeGreaterThan(0);
    const bytes = await fs.readFile(first.file);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');

    const second = await service.get('pics', 'photo.jpg');
    expect(second.file).toBe(first.file);
    expect(second.etag).toBe(first.etag);
    expect((await fs.stat(second.file)).mtimeMs).toBe(stat.mtimeMs);
  });

  it('clamps requested widths and never enlarges the source', async () => {
    const wide = await service.get('pics', 'photo.jpg', 5000);
    expect(wide.width).toBe(128);
    const small = await service.get('pics', 'small.jpg', 128);
    expect(small.width).toBe(128);

    const metadata = await import('sharp').then((module) =>
      module.default(small.file).metadata(),
    );
    expect(metadata.width).toBeLessThanOrEqual(32);
  });

  it('rejects non-images and symlink escapes', async () => {
    await expect(service.get('pics', 'fake.jpg')).rejects.toMatchObject({
      code: 'unsupported-image',
    });

    const link = path.join(rootDir, 'link.jpg');
    let created = false;
    try {
      await fs.symlink(path.join(rootDir, 'photo.jpg'), link, 'file');
      created = true;
    } catch {
      // Ignore platforms without symlink permission.
    }
    if (created) {
      await expect(service.get('pics', 'link.jpg')).rejects.toMatchObject({
        code: 'forbidden-path',
      });
    }
  });

  it('prunes files older than 30 days and enforces the cache size limit', async () => {
    const oldFile = path.join(cacheDir, 'old.webp');
    await fs.writeFile(oldFile, 'old');
    const oldTime = new Date(Date.now() - 31 * 86_400_000);
    await fs.utimes(oldFile, oldTime, oldTime);

    const smallService = new ThumbnailService({
      guard,
      cacheDir,
      maxWidth: 128,
      maxImagePixels: 100_000_000,
      maxCacheBytes: 8,
      concurrency: 2,
    });
    const result = await smallService.prune();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });

    const remaining = await fs.readdir(cacheDir);
    expect(remaining.length).toBeLessThanOrEqual(1);
  });
});
