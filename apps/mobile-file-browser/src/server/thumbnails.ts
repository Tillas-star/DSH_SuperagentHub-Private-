import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { AppError } from './errors';
import { detectImage, makeEtag, matchesEtag } from './images';
import type { PathGuard } from './paths';
import { ensurePrivateDir } from './util/fs';

const PIPELINE_VERSION = '1';
const CACHE_MAX_AGE_MS = 30 * 86_400_000;

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

export interface ThumbnailOptions {
  guard: PathGuard;
  cacheDir: string;
  maxWidth: number;
  maxImagePixels: number;
  maxCacheBytes: number;
  concurrency?: number;
}

export interface ThumbnailResult {
  file: string;
  etag: string;
  width: number;
  mtimeMs: number;
  size: number;
}

export class ThumbnailService {
  private readonly guard: PathGuard;
  private readonly cacheDir: string;
  private readonly maxWidth: number;
  private readonly maxImagePixels: number;
  private readonly maxCacheBytes: number;
  private readonly semaphore: Semaphore;
  private readonly pending = new Map<string, Promise<ThumbnailResult>>();
  private ensuredDir = false;

  constructor(options: ThumbnailOptions) {
    this.guard = options.guard;
    this.cacheDir = options.cacheDir;
    this.maxWidth = options.maxWidth;
    this.maxImagePixels = options.maxImagePixels;
    this.maxCacheBytes = options.maxCacheBytes;
    this.semaphore = new Semaphore(options.concurrency ?? 4);
  }

  async get(rootId: string, relativePath: string, requestedWidth?: number): Promise<ThumbnailResult> {
    const width = Math.max(64, Math.min(this.maxWidth, Math.round(requestedWidth ?? this.maxWidth)));
    const resolved = await this.guard.resolve(rootId, relativePath);
    let stat;
    try {
      stat = await fs.stat(resolved.absolutePath);
    } catch {
      throw new AppError('not-found');
    }
    if (!stat.isFile()) throw new AppError('not-found');

    await detectImage(resolved.absolutePath, path.basename(resolved.absolutePath));

    const key = createHash('sha256')
      .update(
        [
          rootId,
          resolved.relativePath,
          String(stat.mtimeMs),
          String(stat.size),
          String(width),
          PIPELINE_VERSION,
        ].join('\0'),
      )
      .digest('hex');
    const file = path.join(this.cacheDir, `${key}.webp`);
    const etag = makeEtag(stat.mtimeMs, stat.size, `t${width}v${PIPELINE_VERSION}`);

    const existing = await this.cached(file);
    if (existing) return { file, etag, width, mtimeMs: stat.mtimeMs, size: stat.size };

    const inFlight = this.pending.get(key);
    if (inFlight) {
      const result = await inFlight;
      return { ...result, etag, width };
    }

    const task = this.generate(resolved.absolutePath, width, file).then(() => ({
      file,
      etag,
      width,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    }));
    this.pending.set(key, task);
    try {
      const result = await task;
      return result;
    } finally {
      this.pending.delete(key);
    }
  }

  async send(request: FastifyRequest, reply: FastifyReply, result: ThumbnailResult): Promise<FastifyReply> {
    const cacheControl = 'private, max-age=604800';
    if (matchesEtag(request.headers['if-none-match'], result.etag)) {
      reply.code(304).header('ETag', result.etag).header('Cache-Control', cacheControl).send();
      return reply;
    }
    let size: number;
    try {
      size = (await fs.stat(result.file)).size;
    } catch {
      throw new AppError('internal');
    }
    reply
      .headers({
        'Content-Type': 'image/webp',
        'Content-Length': size,
        'Cache-Control': cacheControl,
        ETag: result.etag,
      })
      .send(createReadStream(result.file));
    return reply;
  }

  async prune(): Promise<{ deleted: number; freedBytes: number }> {
    let deleted = 0;
    let freedBytes = 0;
    let entries: Array<{ file: string; size: number; mtimeMs: number }>;
    try {
      const names = await fs.readdir(this.cacheDir);
      entries = [];
      for (const name of names) {
        if (!name.endsWith('.webp') && !name.endsWith('.jpg') && !name.endsWith('.tmp')) continue;
        const file = path.join(this.cacheDir, name);
        try {
          const stat = await fs.stat(file);
          entries.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // File disappeared while pruning; ignore.
        }
      }
    } catch {
      return { deleted, freedBytes };
    }

    const cutoff = Date.now() - CACHE_MAX_AGE_MS;
    const remaining: typeof entries = [];
    for (const entry of entries) {
      if (entry.mtimeMs < cutoff) {
        try {
          await fs.unlink(entry.file);
          deleted += 1;
          freedBytes += entry.size;
        } catch {
          // Ignore.
        }
      } else {
        remaining.push(entry);
      }
    }

    let total = remaining.reduce((sum, entry) => sum + entry.size, 0);
    if (total > this.maxCacheBytes) {
      remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const entry of remaining) {
        if (total <= this.maxCacheBytes) break;
        try {
          await fs.unlink(entry.file);
          total -= entry.size;
          deleted += 1;
          freedBytes += entry.size;
        } catch {
          // Ignore.
        }
      }
    }
    return { deleted, freedBytes };
  }

  private async cached(file: string): Promise<boolean> {
    try {
      const stat = await fs.stat(file);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  private async generate(source: string, width: number, target: string): Promise<void> {
    if (!this.ensuredDir) {
      await ensurePrivateDir(this.cacheDir);
      this.ensuredDir = true;
    }
    await this.semaphore.run(async () => {
      const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await sharp(source, {
          limitInputPixels: this.maxImagePixels,
          failOn: 'error',
          animated: false,
        })
          .rotate()
          .resize({
            width,
            height: width,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 80 })
          .toFile(tmp);
        await fs.rename(tmp, target);
      } catch (error) {
        try {
          await fs.unlink(tmp);
        } catch {
          // Ignore cleanup failure.
        }
        const message = (error as Error).message ?? '';
        if (/unsupported|heif|heic|corrupt|invalid|premature/i.test(message)) {
          throw new AppError('unsupported-image');
        }
        throw new AppError('internal');
      }
    });
  }
}
