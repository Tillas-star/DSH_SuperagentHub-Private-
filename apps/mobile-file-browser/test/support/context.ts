import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../../src/server/app';
import { PasswordStore } from '../../src/server/auth/password';
import { PairingToken } from '../../src/server/auth/pairing';
import { SessionStore } from '../../src/server/auth/session';
import {
  createConfig,
  parseCliArgs,
  type AppConfig,
} from '../../src/server/config';
import { PathGuard } from '../../src/server/paths';
import { ThumbnailService } from '../../src/server/thumbnails';

export interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
  set: (value: number) => void;
}

export function fakeClock(start = Date.now()): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (value) => {
      current = value;
    },
  };
}

export interface TestContextOptions {
  password?: string;
  publicUrl?: string;
  lan?: boolean;
  loginDelayMs?: number;
  now?: () => number;
  maxEntries?: number;
  showHidden?: boolean;
  sessionTtlMs?: number;
  extraArgs?: string[];
}

export interface TestContext {
  baseDir: string;
  rootDir: string;
  dataDir: string;
  cacheDir: string;
  config: AppConfig;
  app: Awaited<ReturnType<typeof createApp>>;
  passwordStore: PasswordStore;
  sessionStore: SessionStore;
  pairing: PairingToken;
  thumbnails: ThumbnailService;
  now: () => number;
  pairCookie: () => Promise<string>;
  close: () => Promise<void>;
}

export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfb-test-'));
  const rootDir = path.join(baseDir, 'root');
  const dataDir = path.join(baseDir, 'data');
  const cacheDir = path.join(baseDir, 'cache');
  await fs.mkdir(rootDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  const now = options.now ?? Date.now;
  const args = ['--root', rootDir, '--port', '0'];
  if (options.lan) args.push('--lan');
  if (options.publicUrl) args.push('--public-url', options.publicUrl);
  if (options.maxEntries !== undefined) args.push('--max-entries', String(options.maxEntries));
  if (options.showHidden) args.push('--show-hidden');
  if (options.sessionTtlMs !== undefined) args.push('--session-ttl', `${Math.round(options.sessionTtlMs / 1000)}s`);
  if (options.extraArgs) args.push(...options.extraArgs);

  const config = await createConfig(parseCliArgs(args), {
    ...process.env,
    MOBILE_FILES_DATA_DIR: dataDir,
    MOBILE_FILES_CACHE_DIR: cacheDir,
  });
  config.loginDelayMs = options.loginDelayMs ?? 0;

  const passwordStore = new PasswordStore(config.dataDir);
  await passwordStore.load();
  if (options.password) await passwordStore.setPassword(options.password);

  const sessionStore = new SessionStore(config.dataDir, config.sessionTtlMs, now);
  await sessionStore.load();

  const pairing = new PairingToken(config.pairingTtlMs, now());
  const guard = new PathGuard(config.roots);
  const thumbnails = new ThumbnailService({
    guard,
    cacheDir: config.thumbsDir,
    maxWidth: config.thumbWidth,
    maxImagePixels: config.maxImagePixels,
    maxCacheBytes: config.thumbsMaxSizeBytes,
    concurrency: 2,
  });

  const app = await createApp({
    config,
    passwordStore,
    sessionStore,
    pairing,
    now,
    loginDelayMs: config.loginDelayMs,
    thumbnails,
  });

  const pairCookie = async (): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/pair',
      payload: { token: pairing.token },
    });
    if (response.statusCode !== 204) {
      throw new Error(`pairing failed: ${response.statusCode} ${response.body}`);
    }
    return firstCookie(response.headers['set-cookie']);
  };

  return {
    baseDir,
    rootDir,
    dataDir,
    cacheDir,
    config,
    app,
    passwordStore,
    sessionStore,
    pairing,
    thumbnails,
    now,
    pairCookie,
    close: async () => {
      await app.close();
      await fs.rm(baseDir, { recursive: true, force: true });
    },
  };
}

export function firstCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('missing Set-Cookie header');
  return value.split(';')[0];
}

export interface ImageOptions {
  width?: number;
  height?: number;
  channel?: number;
}

export async function writeJpeg(file: string, options: ImageOptions = {}): Promise<void> {
  const width = options.width ?? 32;
  const height = options.height ?? 20;
  const channel = options.channel ?? 1;
  const background = { r: 40 + channel * 17, g: 90 + channel * 11, b: 140 + channel * 7 };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background } })
    .jpeg()
    .toFile(file);
}

export async function writePng(file: string, options: ImageOptions = {}): Promise<void> {
  const width = options.width ?? 32;
  const height = options.height ?? 20;
  const background = { r: 120, g: 60, b: 180 };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toFile(file);
}

export async function writeText(file: string, content = 'text'): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}
