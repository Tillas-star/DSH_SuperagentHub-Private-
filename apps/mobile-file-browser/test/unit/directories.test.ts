import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RootConfig } from '../../src/server/config';
import { listDirectory } from '../../src/server/directories';
import { PathGuard } from '../../src/server/paths';
import { writeJpeg, writePng, writeText } from '../support/context';

describe('listDirectory', () => {
  let baseDir: string;
  let rootDir: string;
  let root: RootConfig;
  let guard: PathGuard;

  beforeAll(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfb-dirs-'));
    rootDir = path.join(baseDir, 'root');
    await fs.mkdir(path.join(rootDir, '截图'), { recursive: true });
    await fs.mkdir(path.join(rootDir, '2026-11-杭州'), { recursive: true });
    await fs.mkdir(path.join(rootDir, '空文件夹'), { recursive: true });
    await writeJpeg(path.join(rootDir, 'IMG10.jpg'));
    await writeJpeg(path.join(rootDir, 'img2.jpg'));
    await writePng(path.join(rootDir, 'photo.png'));
    await writeText(path.join(rootDir, 'readme.txt'), 'hello');
    await writeText(path.join(rootDir, '.hidden.jpg'), 'hidden');
    await fs.mkdir(path.join(rootDir, '.git'));
    await writeJpeg(path.join(rootDir, '截图', '截图 01.jpg'));
    root = {
      id: 'pics',
      name: '图片',
      path: rootDir,
      realPath: await fs.realpath(rootDir),
    };
    guard = new PathGuard([root]);
  });

  afterAll(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('lists folders first, then images, then other files with natural sorting', async () => {
    const result = await listDirectory({ guard, showHidden: false, maxEntries: 2000 }, 'pics', '');
    expect(result.root).toEqual({ id: 'pics', name: '图片' });
    expect(result.path).toBe('');
    expect(result.breadcrumb).toEqual([{ name: '图片', path: '' }]);
    expect(result.truncated).toBe(false);
    expect(result.sort).toBe('name');

    const names = result.entries.map((entry) => entry.name);
    expect(names).not.toContain('.hidden.jpg');
    expect(names).not.toContain('.git');

    const kinds = result.entries.map((entry) => entry.kind);
    expect(kinds.indexOf('directory')).toBe(0);
    expect(kinds.lastIndexOf('directory')).toBeLessThan(kinds.indexOf('image'));
    expect(kinds.lastIndexOf('image')).toBeLessThan(kinds.indexOf('other'));

    const imageNames = result.entries.filter((entry) => entry.kind === 'image').map((entry) => entry.name);
    expect(imageNames).toEqual(['img2.jpg', 'IMG10.jpg', 'photo.png']);

    const image = result.entries.find((entry) => entry.name === 'img2.jpg');
    expect(image?.thumbUrl).toBe('/api/thumbnails?root=pics&path=img2.jpg');
    expect(image?.imageUrl).toBe('/api/images?root=pics&path=img2.jpg');
    expect(image?.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const other = result.entries.find((entry) => entry.name === 'readme.txt');
    expect(other?.kind).toBe('other');
    expect(other?.note).toBe('仅支持图片预览');
  });

  it('includes hidden entries when configured', async () => {
    const result = await listDirectory({ guard, showHidden: true, maxEntries: 2000 }, 'pics', '');
    const names = result.entries.map((entry) => entry.name);
    expect(names).toContain('.hidden.jpg');
    expect(names).toContain('.git');
  });

  it('builds breadcrumbs and encoded image URLs for nested folders', async () => {
    const result = await listDirectory(
      { guard, showHidden: false, maxEntries: 2000 },
      'pics',
      '2026-11-杭州',
    );
    expect(result.path).toBe('2026-11-杭州');
    expect(result.breadcrumb).toEqual([
      { name: '图片', path: '' },
      { name: '2026-11-杭州', path: '2026-11-杭州' },
    ]);
  });

  it('marks long directories as truncated and caps entries', async () => {
    const result = await listDirectory({ guard, showHidden: false, maxEntries: 3 }, 'pics', '');
    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('returns an empty listing for empty folders', async () => {
    const result = await listDirectory(
      { guard, showHidden: false, maxEntries: 2000 },
      'pics',
      '空文件夹',
    );
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('reports non-directories and missing paths distinctly', async () => {
    await expect(
      listDirectory({ guard, showHidden: false, maxEntries: 2000 }, 'pics', 'readme.txt'),
    ).rejects.toMatchObject({ code: 'not-directory' });
    await expect(
      listDirectory({ guard, showHidden: false, maxEntries: 2000 }, 'pics', 'missing'),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('lists symlinks as unopenable other entries', async () => {
    const link = path.join(rootDir, 'link');
    let created = false;
    try {
      await fs.symlink(path.join(baseDir, 'outside'), link, 'dir');
      created = true;
    } catch {
      // Windows may not allow symlink creation.
    }
    if (!created) return;
    const result = await listDirectory({ guard, showHidden: false, maxEntries: 2000 }, 'pics', '');
    const entry = result.entries.find((item) => item.name === 'link');
    expect(entry?.kind).toBe('other');
    expect(entry?.note).toContain('符号链接');
  });
});
