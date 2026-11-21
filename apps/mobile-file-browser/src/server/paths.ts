import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RootConfig } from './config';
import { AppError } from './errors';

export interface ResolvedPath {
  root: RootConfig;
  /** Canonical absolute path on disk. Never send this to the client. */
  absolutePath: string;
  /** Normalized relative path using forward slashes ('' for the root). */
  relativePath: string;
  segments: string[];
}

/**
 * Split a client-supplied relative path into safe segments.
 *
 * The input arrives already URL-decoded once by the query parser. We reject
 * absolute paths, drive letters, UNC/device paths, NUL bytes, empty segments,
 * and both "." and "..". Windows and POSIX separators are both treated as
 * separators.
 */
export function parseRelativePath(input: string | undefined | null): string[] {
  if (input === undefined || input === null || input === '') return [];
  if (typeof input !== 'string') throw new AppError('forbidden-path');
  if (input.length > 8192) throw new AppError('forbidden-path');
  if (input.includes('\0')) throw new AppError('forbidden-path');

  let value = input;
  if (value.startsWith('/') || value.startsWith('\\')) throw new AppError('forbidden-path');
  if (/^[A-Za-z]:/.test(value)) throw new AppError('forbidden-path');
  if (value.startsWith('\\\\') || value.startsWith('//')) throw new AppError('forbidden-path');
  // Strip a single trailing separator so "folder/" is treated as "folder".
  while (value.endsWith('/') || value.endsWith('\\')) value = value.slice(0, -1);
  if (value === '') return [];

  const segments = value.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new AppError('forbidden-path');
    }
    if (segment.includes('\0')) throw new AppError('forbidden-path');
  }
  return segments;
}

export function isPathInside(parent: string, candidate: string): boolean {
  const normalizedParent = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const relative = path.relative(normalizedParent, normalizedCandidate);
  if (relative === '') return true;
  if (relative === '..') return false;
  return !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class PathGuard {
  private readonly rootsById = new Map<string, RootConfig>();

  constructor(private readonly roots: RootConfig[]) {
    for (const root of roots) this.rootsById.set(root.id, root);
  }

  listRoots(): RootConfig[] {
    return this.roots;
  }

  getRoot(rootId: string): RootConfig {
    const root = this.rootsById.get(rootId);
    if (!root) throw new AppError('not-found');
    return root;
  }

  async resolve(rootId: string, relativePath: string | undefined | null): Promise<ResolvedPath> {
    const root = this.getRoot(rootId);
    const segments = parseRelativePath(relativePath);

    let current = root.realPath;
    for (let index = 0; index < segments.length; index += 1) {
      const next = path.join(current, segments[index]);
      let stats;
      try {
        stats = await fs.lstat(next);
      } catch (error) {
        throw mapFsError(error);
      }
      if (stats.isSymbolicLink()) throw new AppError('forbidden-path');
      const isLast = index === segments.length - 1;
      if (!isLast && !stats.isDirectory()) throw new AppError('not-directory');
      current = next;
    }

    let real: string;
    try {
      real = await fs.realpath(current);
    } catch (error) {
      throw mapFsError(error);
    }
    if (!isPathInside(root.realPath, real)) throw new AppError('forbidden-path');

    const relativePathOut = segments.join('/');
    return {
      root,
      absolutePath: real,
      relativePath: relativePathOut,
      segments,
    };
  }
}

export function mapFsError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new AppError('not-found');
  if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') {
    return new AppError('forbidden-path');
  }
  return new AppError('not-found');
}
