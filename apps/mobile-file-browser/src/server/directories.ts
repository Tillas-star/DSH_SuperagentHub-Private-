import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Breadcrumb, DirectoryResponse, Entry, EntryKind } from '../shared/types';
import type { AppConfig } from './config';
import { AppError } from './errors';
import { mapFsError } from './paths';
import { isImageName } from './images';
import type { PathGuard } from './paths';

const collator = new Intl.Collator(['zh-Hans-CN', 'en'], {
  numeric: true,
  sensitivity: 'base',
  usage: 'sort',
});

const KIND_RANK: Record<EntryKind, number> = {
  directory: 0,
  image: 1,
  other: 2,
};

interface LightEntry {
  name: string;
  kind: EntryKind;
  symbolLink: boolean;
}

export interface DirectoryOptions {
  guard: PathGuard;
  showHidden: boolean;
  maxEntries: number;
}

export async function listDirectory(
  options: DirectoryOptions,
  rootId: string,
  relativePath: string | undefined,
): Promise<DirectoryResponse> {
  const resolved = await options.guard.resolve(rootId, relativePath);
  let stats;
  try {
    stats = await fs.stat(resolved.absolutePath);
  } catch (error) {
    throw mapFsError(error);
  }
  if (!stats.isDirectory()) throw new AppError('not-directory');

  let dirents;
  try {
    dirents = await fs.readdir(resolved.absolutePath, { withFileTypes: true });
  } catch (error) {
    throw mapFsError(error);
  }

  const light: LightEntry[] = [];
  for (const dirent of dirents) {
    if (!options.showHidden && dirent.name.startsWith('.')) continue;
    const symbolLink = dirent.isSymbolicLink();
    const kind: EntryKind = symbolLink
      ? 'other'
      : dirent.isDirectory()
        ? 'directory'
        : isImageName(dirent.name)
          ? 'image'
          : 'other';
    light.push({ name: dirent.name, kind, symbolLink });
  }

  light.sort((a, b) => {
    const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (rank !== 0) return rank;
    return collator.compare(a.name, b.name);
  });

  const truncated = light.length > options.maxEntries;
  const selected = light.slice(0, options.maxEntries);
  const entries: Entry[] = [];
  for (const item of selected) {
    const entry: Entry = { name: item.name, kind: item.kind };
    if (item.symbolLink) {
      entry.note = '符号链接，不在浏览范围内';
      entries.push(entry);
      continue;
    }
    let itemStats;
    try {
      itemStats = await fs.lstat(path.join(resolved.absolutePath, item.name));
    } catch {
      entry.note = '无法读取';
      entries.push(entry);
      continue;
    }
    entry.size = itemStats.size;
    entry.mtime = itemStats.mtime.toISOString();
    if (item.kind === 'other') {
      entry.note = '仅支持图片预览';
    }
    if (item.kind === 'image') {
      const relative = resolved.segments.length
        ? `${resolved.relativePath}/${item.name}`
        : item.name;
      const params = new URLSearchParams({ root: rootId, path: relative });
      entry.thumbUrl = `/api/thumbnails?${params.toString()}`;
      const imageParams = new URLSearchParams({ root: rootId, path: relative });
      entry.imageUrl = `/api/images?${imageParams.toString()}`;
      if (/\.(heic|heif)$/i.test(item.name)) {
        const previewParams = new URLSearchParams({ root: rootId, path: relative, preview: '1' });
        entry.previewUrl = `/api/images?${previewParams.toString()}`;
      }
    }
    entries.push(entry);
  }

  const breadcrumb: Breadcrumb[] = [{ name: resolved.root.name, path: '' }];
  let accumulated = '';
  for (const segment of resolved.segments) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    breadcrumb.push({ name: segment, path: accumulated });
  }

  return {
    root: { id: resolved.root.id, name: resolved.root.name },
    path: resolved.relativePath,
    breadcrumb,
    entries,
    truncated,
    sort: 'name',
  };
}

export function describeRoots(config: AppConfig): Array<{ id: string; name: string }> {
  return config.roots.map((root) => ({ id: root.id, name: root.name }));
}
