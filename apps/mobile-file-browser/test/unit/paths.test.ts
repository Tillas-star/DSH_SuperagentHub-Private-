import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RootConfig } from '../../src/server/config';
import { AppError } from '../../src/server/errors';
import { isPathInside, parseRelativePath, PathGuard } from '../../src/server/paths';
import { removeTempDir } from '../support/cleanup';

describe('parseRelativePath', () => {
  it('accepts ordinary relative paths and empty roots', () => {
    expect(parseRelativePath('')).toEqual([]);
    expect(parseRelativePath(undefined)).toEqual([]);
    expect(parseRelativePath('a/b')).toEqual(['a', 'b']);
    expect(parseRelativePath('2026-11/杭州')).toEqual(['2026-11', '杭州']);
    expect(parseRelativePath('emoji😀/file name.jpg')).toEqual(['emoji😀', 'file name.jpg']);
    expect(parseRelativePath('folder/')).toEqual(['folder']);
  });

  it.each([
    '/etc/passwd',
    '\\server\\share',
    'C:\\Windows',
    'C:relative',
    '..',
    '../secret',
    'a/../b',
    'a/./b',
    'a//b',
    'a\\..\\b',
    'a\0b',
    '.',
  ])('rejects %j', (input) => {
    expect(() => parseRelativePath(input)).toThrow(AppError);
  });

  it('rejects oversized paths', () => {
    expect(() => parseRelativePath('a'.repeat(9000))).toThrow(AppError);
  });
});

describe('isPathInside', () => {
  it('accepts the root itself and descendants', () => {
    expect(isPathInside('/data/root', '/data/root')).toBe(true);
    expect(isPathInside('/data/root', '/data/root/a/b')).toBe(true);
  });

  it('rejects siblings and parent traversal', () => {
    expect(isPathInside('/data/root', '/data/root-evil')).toBe(false);
    expect(isPathInside('/data/root', '/data')).toBe(false);
    expect(isPathInside('/data/root', '/data/root/../secret')).toBe(false);
  });
});

describe('PathGuard', () => {
  let baseDir: string;
  let root: RootConfig;
  let guard: PathGuard;

  beforeAll(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfb-paths-'));
    const rootDir = path.join(baseDir, 'root');
    await fs.mkdir(path.join(rootDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'sub', 'file.txt'), 'hello');
    await fs.writeFile(path.join(baseDir, 'outside.txt'), 'secret');
    root = {
      id: 'root-1',
      name: '根目录',
      path: rootDir,
      realPath: await fs.realpath(rootDir),
    };
    guard = new PathGuard([root]);
  });

  afterAll(async () => {
    await removeTempDir(baseDir);
  });

  it('resolves nested paths inside the root', async () => {
    const resolved = await guard.resolve('root-1', 'sub/file.txt');
    expect(resolved.relativePath).toBe('sub/file.txt');
    expect(resolved.segments).toEqual(['sub', 'file.txt']);
    expect(isPathInside(root.realPath, resolved.absolutePath)).toBe(true);
  });

  it('rejects unknown roots', async () => {
    await expect(guard.resolve('nope', '')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('reports missing paths without exposing them', async () => {
    await expect(guard.resolve('root-1', 'missing')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects symlinks that leave or stay inside the root', async () => {
    const link = path.join(root.realPath, 'link');
    let created = false;
    try {
      await fs.symlink(path.join(baseDir, 'outside.txt'), link, 'file');
      created = true;
    } catch {
      // Windows may not permit symlink creation without developer mode.
    }
    if (!created) return;
    await expect(guard.resolve('root-1', 'link')).rejects.toMatchObject({ code: 'forbidden-path' });
  });
});
