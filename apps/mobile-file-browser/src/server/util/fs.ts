import { promises as fs } from 'node:fs';
import path from 'node:path';

/** mkdir -p with owner-only permissions (best effort on platforms without POSIX modes). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Windows and some filesystems do not support POSIX modes.
  }
}

/** Write a file atomically, replacing the destination. */
export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await ensureDirFor(file);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, { mode });
  try {
    await fs.chmod(tmp, mode);
  } catch {
    // Ignore unsupported chmod.
  }
  await fs.rename(tmp, file);
}

export async function ensureDirFor(file: string): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt state files should not prevent the server from starting.
    return null;
  }
}

export function parseDurationMs(input: string, optionName = '时长'): number {
  const match = /^(\d+)(ms|s|m|h|d)$/i.exec(input.trim());
  if (!match) {
    throw new Error(`${optionName}格式不正确，请使用 30d、12h、30m 或 60s 这样的写法`);
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor =
    unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * factor;
}

export function parseByteSize(input: string, optionName = '容量'): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i.exec(input.trim());
  if (!match) {
    throw new Error(`${optionName}格式不正确，请使用 2GB、500MB 这样的写法`);
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const factor =
    unit === 'b'
      ? 1
      : unit === 'kb'
        ? 1024
        : unit === 'mb'
          ? 1024 ** 2
          : unit === 'gb'
            ? 1024 ** 3
            : 1024 ** 4;
  return Math.round(value * factor);
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} 天`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  return `${Math.round(ms / 1000)} 秒`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
