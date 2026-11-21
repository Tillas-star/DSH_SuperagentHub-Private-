import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccessMode } from '../shared/types';
import { APP_VERSION } from '../shared/version';
import { parseByteSize, parseDurationMs } from './util/fs';

export interface RootConfig {
  id: string;
  name: string;
  /** Path exactly as configured (for error messages shown on the computer). */
  path: string;
  /** Canonical absolute path used for all filesystem access. */
  realPath: string;
}

export interface AppConfig {
  roots: RootConfig[];
  lan: boolean;
  publicUrl?: URL;
  trustedHosts: string[];
  port: number;
  /** Bind address derived from lan/remote mode. */
  host: string;
  showHidden: boolean;
  maxEntries: number;
  thumbWidth: number;
  thumbsDir: string;
  thumbsMaxSizeBytes: number;
  sessionTtlMs: number;
  pairingTtlMs: number;
  loginDelayMs: number;
  maxImagePixels: number;
  tlsCert?: string;
  tlsKey?: string;
  verbose: boolean;
  dataDir: string;
  mode: AccessMode;
}

export interface CliOptions {
  roots: string[];
  lan?: boolean;
  publicUrl?: string;
  setPassword: boolean;
  trustedHosts: string[];
  port?: number;
  config?: string;
  showHidden?: boolean;
  maxEntries?: number;
  thumbWidth?: number;
  thumbsDir?: string;
  thumbsMaxSize?: string;
  sessionTtl?: string;
  tlsCert?: string;
  tlsKey?: string;
  resetSessions: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {
  readonly code = 'usage';
}

const BOOLEAN_FLAGS = new Set([
  '--lan',
  '--set-password',
  '--show-hidden',
  '--reset-sessions',
  '--verbose',
  '--help',
  '-h',
  '--version',
]);

const VALUE_FLAGS = new Set([
  '--root',
  '--public-url',
  '--trusted-host',
  '--port',
  '--config',
  '--max-entries',
  '--thumb-width',
  '--thumbs-dir',
  '--thumbs-max-size',
  '--session-ttl',
  '--tls-cert',
  '--tls-key',
]);

export const USAGE = `mobile-files ${APP_VERSION}

只读的手机文件/图片浏览器。所有参数都是可选的，除了至少一个 --root。

用法:
  npm start -- --root <目录> [--root <目录> ...] [选项]
  npm start -- --set-password
  npm start -- --help

选项:
  --root <目录>          允许浏览的根目录，可重复
  --lan                  监听所有网卡，允许同一局域网访问
  --public-url <URL>     外网 HTTPS 源（例如 https://files.example.com）
  --set-password         交互设置/修改访问密码后退出
  --trusted-host <host>  额外允许的 Host，可重复（隧道改写 Host 时使用）
  --port <端口>          监听端口，默认 8787
  --config <文件>        JSON 配置文件；命令行参数优先
  --show-hidden          显示点号开头的文件和目录
  --max-entries <数量>   单目录最多返回条数，默认 2000
  --thumb-width <像素>   缩略图最大边，默认 640
  --thumbs-dir <目录>    缩略图缓存目录
  --thumbs-max-size <容量> 缓存上限，默认 2GB
  --session-ttl <时长>   会话有效期，默认 30d
  --tls-cert <文件>      本地 HTTPS 证书（通常不需要，隧道会终止 TLS）
  --tls-key <文件>       本地 HTTPS 私钥
  --reset-sessions       启动时清空所有会话
  --verbose              输出调试日志（不记录完整文件路径和密码）
  --help                 显示帮助
  --version              显示版本
`;

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    roots: [],
    setPassword: false,
    trustedHosts: [],
    resetSessions: false,
    verbose: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('-')) {
      throw new UsageError(`无法识别的参数: ${raw}`);
    }

    let name = raw;
    let inlineValue: string | undefined;
    const eq = raw.indexOf('=');
    if (eq > 0) {
      name = raw.slice(0, eq);
      inlineValue = raw.slice(eq + 1);
    }

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        throw new UsageError(`参数 ${name} 不接受值`);
      }
      switch (name) {
        case '--lan':
          options.lan = true;
          break;
        case '--set-password':
          options.setPassword = true;
          break;
        case '--show-hidden':
          options.showHidden = true;
          break;
        case '--reset-sessions':
          options.resetSessions = true;
          break;
        case '--verbose':
          options.verbose = true;
          break;
        case '--help':
        case '-h':
          options.help = true;
          break;
        case '--version':
          options.version = true;
          break;
      }
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      throw new UsageError(`未知参数: ${name}`);
    }

    let value = inlineValue;
    if (value === undefined) {
      i += 1;
      value = argv[i];
    }
    if (value === undefined || value === '') {
      throw new UsageError(`参数 ${name} 需要一个值`);
    }

    switch (name) {
      case '--root':
        options.roots.push(value);
        break;
      case '--public-url':
        options.publicUrl = value;
        break;
      case '--trusted-host':
        options.trustedHosts.push(value);
        break;
      case '--port':
        options.port = parsePort(value);
        break;
      case '--config':
        options.config = value;
        break;
      case '--max-entries':
        options.maxEntries = parseInteger(value, '--max-entries', 1, 100_000);
        break;
      case '--thumb-width':
        options.thumbWidth = parseInteger(value, '--thumb-width', 64, 2048);
        break;
      case '--thumbs-dir':
        options.thumbsDir = value;
        break;
      case '--thumbs-max-size':
        options.thumbsMaxSize = value;
        break;
      case '--session-ttl':
        options.sessionTtl = value;
        break;
      case '--tls-cert':
        options.tlsCert = value;
        break;
      case '--tls-key':
        options.tlsKey = value;
        break;
    }
  }

  return options;
}

function parsePort(value: string): number {
  return parseInteger(value, '--port', 0, 65_535);
}

function parseInteger(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`${name} 必须是整数`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new UsageError(`${name} 必须在 ${min} 到 ${max} 之间`);
  }
  return parsed;
}

interface FileRootConfig {
  id?: string;
  name?: string;
  path: string;
}

interface FileConfig {
  roots?: FileRootConfig[];
  lan?: boolean;
  publicUrl?: string;
  trustedHosts?: string[];
  port?: number;
  showHidden?: boolean;
  maxEntries?: number;
  thumbWidth?: number;
  thumbsDir?: string;
  thumbsMaxSize?: string | number;
  sessionTtl?: string;
  tlsCert?: string;
  tlsKey?: string;
}

const FILE_KEYS = new Set([
  'roots',
  'lan',
  'publicUrl',
  'trustedHosts',
  'port',
  'showHidden',
  'maxEntries',
  'thumbWidth',
  'thumbsDir',
  'thumbsMaxSize',
  'sessionTtl',
  'tlsCert',
  'tlsKey',
]);

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MOBILE_FILES_DATA_DIR) return path.resolve(env.MOBILE_FILES_DATA_DIR);
  if (process.platform === 'win32') {
    const base = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'mobile-files');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'mobile-files');
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'mobile-files');
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MOBILE_FILES_CACHE_DIR) return path.resolve(env.MOBILE_FILES_CACHE_DIR);
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'mobile-files', 'cache');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'mobile-files');
  }
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'mobile-files');
}

export async function createConfig(
  cli: CliOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppConfig> {
  let fileConfig: FileConfig = {};
  let configDir = process.cwd();
  if (cli.config) {
    const configPath = path.resolve(cli.config);
    configDir = path.dirname(configPath);
    fileConfig = await loadConfigFile(configPath);
  }

  const roots = await resolveRoots(cli, fileConfig, configDir);
  if (roots.length === 0) {
    throw new UsageError('至少需要一个 --root <目录>，或配置文件中的 roots');
  }

  const lan = cli.lan ?? fileConfig.lan ?? false;
  const publicUrlRaw = cli.publicUrl ?? fileConfig.publicUrl;
  const publicUrl = publicUrlRaw ? validatePublicUrl(publicUrlRaw) : undefined;
  const trustedHosts = normalizeTrustedHosts([...(fileConfig.trustedHosts ?? []), ...cli.trustedHosts]);

  const port = cli.port ?? fileConfig.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new UsageError('端口必须在 0 到 65535 之间');
  }

  const showHidden = cli.showHidden ?? fileConfig.showHidden ?? false;
  const maxEntriesRaw = cli.maxEntries ?? fileConfig.maxEntries;
  const maxEntries =
    maxEntriesRaw === undefined ? 2000 : validateIntegerRange(maxEntriesRaw, 'maxEntries', 1, 100_000);
  const thumbWidthRaw = cli.thumbWidth ?? fileConfig.thumbWidth;
  const thumbWidth =
    thumbWidthRaw === undefined ? 640 : validateIntegerRange(thumbWidthRaw, 'thumbWidth', 64, 2048);

  const thumbsDir = path.resolve(
    cli.thumbsDir ??
      (fileConfig.thumbsDir ? path.resolve(configDir, fileConfig.thumbsDir) : path.join(defaultCacheDir(env), 'thumbs')),
  );

  const thumbsMaxSizeBytes =
    cli.thumbsMaxSize !== undefined
      ? parseByteSize(cli.thumbsMaxSize, '--thumbs-max-size')
      : fileConfig.thumbsMaxSize !== undefined
        ? typeof fileConfig.thumbsMaxSize === 'number'
          ? Math.max(1, fileConfig.thumbsMaxSize)
          : parseByteSize(fileConfig.thumbsMaxSize, 'thumbnails maxSize')
        : 2 * 1024 ** 3;

  const sessionTtlMs =
    cli.sessionTtl !== undefined
      ? parseDurationMs(cli.sessionTtl, '--session-ttl')
      : fileConfig.sessionTtl !== undefined
        ? parseDurationMs(fileConfig.sessionTtl, 'sessionTtl')
        : 30 * 86_400_000;
  if (sessionTtlMs < 60_000 || sessionTtlMs > 365 * 86_400_000) {
    throw new UsageError('会话有效期必须在 1 分钟到 365 天之间');
  }

  const tlsCertRaw = cli.tlsCert ?? fileConfig.tlsCert;
  const tlsKeyRaw = cli.tlsKey ?? fileConfig.tlsKey;
  if ((tlsCertRaw && !tlsKeyRaw) || (!tlsCertRaw && tlsKeyRaw)) {
    throw new UsageError('--tls-cert 与 --tls-key 必须同时提供');
  }
  const tlsCert = tlsCertRaw ? path.resolve(configDir, tlsCertRaw) : undefined;
  const tlsKey = tlsKeyRaw ? path.resolve(configDir, tlsKeyRaw) : undefined;
  if (tlsCert && tlsKey) {
    for (const file of [tlsCert, tlsKey]) {
      try {
        await fs.access(file);
      } catch {
        throw new UsageError(`找不到 TLS 文件: ${file}`);
      }
    }
  }

  const mode: AccessMode = publicUrl ? 'remote' : lan ? 'lan' : 'local';
  const host = lan ? '0.0.0.0' : '127.0.0.1';

  return {
    roots,
    lan,
    publicUrl,
    trustedHosts,
    port,
    host,
    showHidden,
    maxEntries,
    thumbWidth,
    thumbsDir,
    thumbsMaxSizeBytes,
    sessionTtlMs,
    pairingTtlMs: 10 * 60_000,
    loginDelayMs: 300,
    maxImagePixels: 100_000_000,
    tlsCert,
    tlsKey,
    verbose: cli.verbose,
    dataDir: defaultDataDir(env),
    mode,
  };
}

async function loadConfigFile(file: string): Promise<FileConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new UsageError(`找不到配置文件: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`配置文件不是合法的 JSON: ${file}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError('配置文件必须是一个 JSON 对象');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FILE_KEYS.has(key)) {
      throw new UsageError(`配置文件包含未知字段: ${key}`);
    }
  }

  const config: FileConfig = {};
  if (record.roots !== undefined) {
    if (!Array.isArray(record.roots)) throw new UsageError('roots 必须是数组');
    config.roots = record.roots.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new UsageError(`roots[${index}] 必须是对象`);
      }
      const root = item as Record<string, unknown>;
      if (typeof root.path !== 'string' || !root.path) {
        throw new UsageError(`roots[${index}].path 必须是非空字符串`);
      }
      for (const key of Object.keys(root)) {
        if (!['id', 'name', 'path'].includes(key)) {
          throw new UsageError(`roots[${index}] 包含未知字段: ${key}`);
        }
      }
      return {
        id: typeof root.id === 'string' ? root.id : undefined,
        name: typeof root.name === 'string' ? root.name : undefined,
        path: root.path,
      };
    });
  }
  if (record.lan !== undefined) {
    if (typeof record.lan !== 'boolean') throw new UsageError('lan 必须是布尔值');
    config.lan = record.lan;
  }
  if (record.publicUrl !== undefined) {
    if (typeof record.publicUrl !== 'string') throw new UsageError('publicUrl 必须是字符串');
    config.publicUrl = record.publicUrl;
  }
  if (record.trustedHosts !== undefined) {
    if (!Array.isArray(record.trustedHosts) || record.trustedHosts.some((host) => typeof host !== 'string')) {
      throw new UsageError('trustedHosts 必须是字符串数组');
    }
    config.trustedHosts = record.trustedHosts;
  }
  if (record.port !== undefined) {
    if (typeof record.port !== 'number') throw new UsageError('port 必须是数字');
    config.port = record.port;
  }
  if (record.showHidden !== undefined) {
    if (typeof record.showHidden !== 'boolean') throw new UsageError('showHidden 必须是布尔值');
    config.showHidden = record.showHidden;
  }
  if (record.maxEntries !== undefined) {
    if (typeof record.maxEntries !== 'number') throw new UsageError('maxEntries 必须是数字');
    config.maxEntries = record.maxEntries;
  }
  if (record.thumbWidth !== undefined) {
    if (typeof record.thumbWidth !== 'number') throw new UsageError('thumbWidth 必须是数字');
    config.thumbWidth = record.thumbWidth;
  }
  if (record.thumbsDir !== undefined) {
    if (typeof record.thumbsDir !== 'string') throw new UsageError('thumbsDir 必须是字符串');
    config.thumbsDir = record.thumbsDir;
  }
  if (record.thumbsMaxSize !== undefined) {
    if (typeof record.thumbsMaxSize !== 'string' && typeof record.thumbsMaxSize !== 'number') {
      throw new UsageError('thumbsMaxSize 必须是字符串或数字');
    }
    config.thumbsMaxSize = record.thumbsMaxSize;
  }
  if (record.sessionTtl !== undefined) {
    if (typeof record.sessionTtl !== 'string') throw new UsageError('sessionTtl 必须是字符串');
    config.sessionTtl = record.sessionTtl;
  }
  if (record.tlsCert !== undefined) {
    if (typeof record.tlsCert !== 'string') throw new UsageError('tlsCert 必须是字符串');
    config.tlsCert = record.tlsCert;
  }
  if (record.tlsKey !== undefined) {
    if (typeof record.tlsKey !== 'string') throw new UsageError('tlsKey 必须是字符串');
    config.tlsKey = record.tlsKey;
  }
  return config;
}

async function resolveRoots(
  cli: CliOptions,
  fileConfig: FileConfig,
  configDir: string,
): Promise<RootConfig[]> {
  const useCliRoots = cli.roots.length > 0;
  const source: FileRootConfig[] = useCliRoots
    ? cli.roots.map((rootPath) => ({ path: rootPath }))
    : (fileConfig.roots ?? []);

  const seenIds = new Set<string>();
  const roots: RootConfig[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const item = source[index];
    const configuredPath = useCliRoots ? path.resolve(item.path) : path.resolve(configDir, item.path);
    let realPath: string;
    try {
      realPath = await fs.realpath(configuredPath);
    } catch {
      throw new UsageError(`根目录不存在或不可访问: ${item.path}`);
    }
    const stat = await fs.stat(realPath);
    if (!stat.isDirectory()) {
      throw new UsageError(`根目录不是文件夹: ${item.path}`);
    }

    const baseName = path.basename(configuredPath) || path.parse(configuredPath).root || '根目录';
    let name = (item.name ?? baseName).trim();
    if (!name) name = baseName;
    if (name.length > 80) name = name.slice(0, 80);

    let id = (item.id ?? `root-${index + 1}`).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new UsageError(`根目录 id 只能包含字母、数字、下划线和连字符: ${id}`);
    }
    let suffix = 2;
    const originalId = id;
    while (seenIds.has(id)) {
      id = `${originalId}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(id);

    roots.push({ id, name, path: configuredPath, realPath });
  }
  return roots;
}

export function validatePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError('--public-url 不是合法的 URL');
  }
  if (url.protocol !== 'https:') {
    throw new UsageError('--public-url 必须是 https:// 地址；公网 HTTP 地址被拒绝');
  }
  if (url.username || url.password) {
    throw new UsageError('--public-url 不能包含用户名或密码');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new UsageError('--public-url 只能是源地址，不能带路径、查询参数或锚点');
  }
  return url;
}

export function normalizeTrustedHosts(hosts: string[]): string[] {
  const result: string[] = [];
  for (const raw of hosts) {
    const host = raw.trim().toLowerCase();
    if (!host) continue;
    if (host.includes('/')) {
      throw new UsageError(`--trusted-host 必须是主机名，不能包含路径: ${raw}`);
    }
    if (!result.includes(host)) result.push(host);
  }
  return result;
}

function validateIntegerRange(
  value: number | undefined,
  name: string,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

export function describeMode(config: AppConfig): string {
  if (config.mode === 'remote') return '远程（仅回环，需隧道）';
  if (config.mode === 'lan') return '局域网（所有网卡）';
  return '本机（仅回环）';
}

export function lanIpv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}
