import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConfig,
  normalizeTrustedHosts,
  parseCliArgs,
  UsageError,
  validatePublicUrl,
} from '../../src/server/config';
import { parseByteSize, parseDurationMs } from '../../src/server/util/fs';

describe('parseCliArgs', () => {
  it('parses repeated roots and options', () => {
    const options = parseCliArgs([
      '--root',
      '/a',
      '--root=/b',
      '--lan',
      '--port',
      '9000',
      '--trusted-host',
      'files.internal',
      '--public-url',
      'https://files.example.com',
      '--show-hidden',
      '--verbose',
    ]);
    expect(options.roots).toEqual(['/a', '/b']);
    expect(options.lan).toBe(true);
    expect(options.port).toBe(9000);
    expect(options.trustedHosts).toEqual(['files.internal']);
    expect(options.publicUrl).toBe('https://files.example.com');
    expect(options.showHidden).toBe(true);
    expect(options.verbose).toBe(true);
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseCliArgs(['--nope'])).toThrow(UsageError);
    expect(() => parseCliArgs(['--root'])).toThrow(UsageError);
    expect(() => parseCliArgs(['--port', 'abc'])).toThrow(UsageError);
    expect(() => parseCliArgs(['--port', '70000'])).toThrow(UsageError);
  });
});

describe('validatePublicUrl', () => {
  it('accepts a clean https origin', () => {
    expect(validatePublicUrl('https://files.example.com').origin).toBe('https://files.example.com');
    expect(validatePublicUrl('https://files.example.com:8443').port).toBe('8443');
  });

  it.each([
    'http://files.example.com',
    'https://files.example.com/path',
    'https://files.example.com/?x=1',
    'https://files.example.com/#hash',
    'https://user:pass@files.example.com',
    'not a url',
  ])('rejects %j', (value) => {
    expect(() => validatePublicUrl(value)).toThrow(UsageError);
  });
});

describe('duration and size parsing', () => {
  it('parses durations', () => {
    expect(parseDurationMs('30d')).toBe(30 * 86_400_000);
    expect(parseDurationMs('12h')).toBe(12 * 3_600_000);
    expect(parseDurationMs('30m')).toBe(30 * 60_000);
    expect(() => parseDurationMs('30')).toThrow();
  });

  it('parses byte sizes', () => {
    expect(parseByteSize('2GB')).toBe(2 * 1024 ** 3);
    expect(parseByteSize('500 mb')).toBe(500 * 1024 ** 2);
    expect(parseByteSize('1024')).toBe(1024);
    expect(() => parseByteSize('many')).toThrow();
  });
});

describe('normalizeTrustedHosts', () => {
  it('lowercases, trims and deduplicates', () => {
    expect(normalizeTrustedHosts([' Files.Internal ', 'files.internal', 'a:8443'])).toEqual([
      'files.internal',
      'a:8443',
    ]);
  });

  it('rejects paths', () => {
    expect(() => normalizeTrustedHosts(['files.internal/path'])).toThrow(UsageError);
  });
});

describe('createConfig', () => {
  let baseDir: string;
  let rootA: string;
  let rootB: string;

  beforeAll(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfb-config-'));
    rootA = path.join(baseDir, 'Pictures');
    rootB = path.join(baseDir, 'Desktop');
    await fs.mkdir(rootA);
    await fs.mkdir(rootB);
  });

  afterAll(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('builds local, lan and remote modes with defaults', async () => {
    const env = {
      ...process.env,
      MOBILE_FILES_DATA_DIR: path.join(baseDir, 'data'),
      MOBILE_FILES_CACHE_DIR: path.join(baseDir, 'cache'),
    };
    const local = await createConfig(parseCliArgs(['--root', rootA]), env);
    expect(local.mode).toBe('local');
    expect(local.host).toBe('127.0.0.1');
    expect(local.port).toBe(8787);
    expect(local.maxEntries).toBe(2000);
    expect(local.thumbWidth).toBe(640);
    expect(local.sessionTtlMs).toBe(30 * 86_400_000);
    expect(local.roots[0].name).toBe('Pictures');
    expect(local.roots[0].realPath).toBe(await fs.realpath(rootA));
    expect(local.thumbsDir).toBe(path.join(baseDir, 'cache', 'thumbs'));

    const lan = await createConfig(parseCliArgs(['--root', rootA, '--lan']), env);
    expect(lan.mode).toBe('lan');
    expect(lan.host).toBe('0.0.0.0');

    const remote = await createConfig(
      parseCliArgs([
        '--root',
        rootA,
        '--public-url',
        'https://files.example.com',
        '--trusted-host',
        'files.internal',
        '--port',
        '9999',
        '--max-entries',
        '50',
        '--thumb-width',
        '320',
        '--show-hidden',
      ]),
      env,
    );
    expect(remote.mode).toBe('remote');
    expect(remote.host).toBe('127.0.0.1');
    expect(remote.publicUrl?.origin).toBe('https://files.example.com');
    expect(remote.trustedHosts).toEqual(['files.internal']);
    expect(remote.port).toBe(9999);
    expect(remote.maxEntries).toBe(50);
    expect(remote.thumbWidth).toBe(320);
    expect(remote.showHidden).toBe(true);
  });

  it('merges a JSON config file with CLI precedence', async () => {
    const env = {
      ...process.env,
      MOBILE_FILES_DATA_DIR: path.join(baseDir, 'data2'),
      MOBILE_FILES_CACHE_DIR: path.join(baseDir, 'cache2'),
    };
    const configFile = path.join(baseDir, 'config.json');
    await fs.writeFile(
      configFile,
      JSON.stringify({
        roots: [
          { id: 'pics', name: '图片', path: rootA },
          { id: 'desk', name: '桌面', path: rootB },
        ],
        lan: true,
        port: 8080,
        maxEntries: 100,
        sessionTtl: '7d',
      }),
    );
    const config = await createConfig(parseCliArgs(['--config', configFile]), env);
    expect(config.roots.map((root) => root.id)).toEqual(['pics', 'desk']);
    expect(config.roots[0].name).toBe('图片');
    expect(config.lan).toBe(true);
    expect(config.port).toBe(8080);
    expect(config.sessionTtlMs).toBe(7 * 86_400_000);

    const overridden = await createConfig(
      parseCliArgs(['--config', configFile, '--port', '8081', '--root', rootB]),
      env,
    );
    expect(overridden.roots).toHaveLength(1);
    expect(overridden.roots[0].realPath).toBe(await fs.realpath(rootB));
    expect(overridden.port).toBe(8081);
  });

  it('requires TLS certificate and key together', async () => {
    const env = { ...process.env, MOBILE_FILES_DATA_DIR: path.join(baseDir, 'd') };
    await expect(
      createConfig(parseCliArgs(['--root', rootA, '--tls-cert', 'cert.pem']), env),
    ).rejects.toThrow(UsageError);
    await expect(
      createConfig(parseCliArgs(['--root', rootA, '--tls-key', 'key.pem']), env),
    ).rejects.toThrow(UsageError);
  });

  it('rejects missing roots, bad config fields and HTTP public URLs', async () => {
    const env = { ...process.env, MOBILE_FILES_DATA_DIR: path.join(baseDir, 'd') };
    await expect(createConfig(parseCliArgs([]), env)).rejects.toThrow(UsageError);
    await expect(
      createConfig(parseCliArgs(['--root', path.join(baseDir, 'missing')]), env),
    ).rejects.toThrow(UsageError);
    await expect(
      createConfig(
        parseCliArgs(['--root', rootA, '--public-url', 'http://files.example.com']),
        env,
      ),
    ).rejects.toThrow(UsageError);

    const badFile = path.join(baseDir, 'bad.json');
    await fs.writeFile(badFile, JSON.stringify({ unknown: true }));
    await expect(createConfig(parseCliArgs(['--config', badFile]), env)).rejects.toThrow(
      UsageError,
    );
  });
});
