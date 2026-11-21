import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import { PasswordStore } from '../../src/server/auth/password';
import { PairingToken } from '../../src/server/auth/pairing';
import { SessionStore } from '../../src/server/auth/session';
import { PathGuard } from '../../src/server/paths';
import { ThumbnailService } from '../../src/server/thumbnails';
import {
  createTestContext,
  fakeClock,
  firstCookie,
  writeJpeg,
  writePng,
  writeText,
  type TestContext,
} from '../support/context';
import { removeTempDir } from '../support/cleanup';

describe('API with a paired session', () => {
  let ctx: TestContext;
  let cookie: string;
  let pairResponse: Awaited<ReturnType<TestContext['app']['inject']>>;
  let symlinkCreated = false;

  beforeAll(async () => {
    ctx = await createTestContext();
    await fs.mkdir(path.join(ctx.rootDir, 'sub'), { recursive: true });
    await fs.mkdir(path.join(ctx.rootDir, '2026-11-杭州'), { recursive: true });
    await fs.mkdir(path.join(ctx.rootDir, '空文件夹'), { recursive: true });
    await writeJpeg(path.join(ctx.rootDir, 'photo.jpg'), { width: 200, height: 100 });
    await writePng(path.join(ctx.rootDir, 'pic.png'));
    await writeJpeg(path.join(ctx.rootDir, 'sub', 'IMG10.jpg'));
    await writeJpeg(path.join(ctx.rootDir, 'sub', 'IMG2.jpg'));
    await writeJpeg(path.join(ctx.rootDir, '2026-11-杭州', '杭州 01.jpg'));
    await writeText(path.join(ctx.rootDir, 'notes.txt'), 'notes');
    await writeText(path.join(ctx.rootDir, 'fake.jpg'), 'not an image');
    await writeText(path.join(ctx.rootDir, '.hidden.jpg'), 'hidden');

    const outside = path.join(ctx.baseDir, 'outside');
    await fs.mkdir(outside);
    await writeJpeg(path.join(outside, 'secret.jpg'));
    try {
      await fs.symlink(outside, path.join(ctx.rootDir, 'link-out'), 'dir');
      symlinkCreated = true;
    } catch {
      // Ignore platforms without symlink permission.
    }

    pairResponse = await ctx.app.inject({
      method: 'POST',
      url: '/api/session/pair',
      payload: { token: ctx.pairing.token },
    });
    cookie = firstCookie(pairResponse.headers['set-cookie']);
  });

  afterAll(async () => {
    await ctx.close();
  });

  const auth = () => ({ cookie });

  it('reports the unauthenticated session and protects file APIs', async () => {
    const session = await ctx.app.inject({ url: '/api/session' });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      authenticated: false,
      mode: 'local',
      passwordConfigured: false,
    });

    for (const url of [
      '/api/roots',
      '/api/directories?root=root-1',
      '/api/thumbnails?root=root-1&path=photo.jpg',
      '/api/images?root=root-1&path=photo.jpg',
    ]) {
      const response = await ctx.app.inject({ url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().error.code).toBe('unauthorized');
    }
  });

  it('pairs once with a hardened cookie', async () => {
    expect(pairResponse.statusCode).toBe(204);
    const setCookie = Array.isArray(pairResponse.headers['set-cookie'])
      ? pairResponse.headers['set-cookie'][0]
      : pairResponse.headers['set-cookie'];
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=');
    expect(setCookie).not.toContain('Secure');

    const reused = await ctx.app.inject({
      method: 'POST',
      url: '/api/session/pair',
      payload: { token: ctx.pairing.token },
    });
    expect(reused.statusCode).toBe(401);

    const session = await ctx.app.inject({ url: '/api/session', headers: auth() });
    const body = session.json();
    expect(body.authenticated).toBe(true);
    expect(body.pairingAvailable).toBe(false);
    expect(typeof body.expiresAt).toBe('string');
  });

  it('adds security headers to API responses', async () => {
    const response = await ctx.app.inject({ url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('lists directories with kinds, natural sorting and breadcrumbs', async () => {
    const response = await ctx.app.inject({ url: '/api/directories?root=root-1', headers: auth() });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body.root).toEqual({ id: 'root-1', name: 'root' });
    expect(body.breadcrumb).toEqual([{ name: 'root', path: '' }]);
    expect(body.entries.map((entry: { name: string }) => entry.name)).not.toContain('.hidden.jpg');
    if (symlinkCreated) {
      expect(body.entries.map((entry: { name: string }) => entry.name)).toContain('link-out');
    }

    const sub = await ctx.app.inject({
      url: '/api/directories?root=root-1&path=sub',
      headers: auth(),
    });
    expect(sub.statusCode).toBe(200);
    const imageNames = sub
      .json()
      .entries.filter((entry: { kind: string }) => entry.kind === 'image')
      .map((entry: { name: string }) => entry.name);
    expect(imageNames).toEqual(['IMG2.jpg', 'IMG10.jpg']);
    expect(sub.json().breadcrumb).toEqual([
      { name: 'root', path: '' },
      { name: 'sub', path: 'sub' },
    ]);

    const unicode = await ctx.app.inject({
      url: '/api/directories?root=root-1&path=2026-11-%E6%9D%AD%E5%B7%9E',
      headers: auth(),
    });
    expect(unicode.statusCode).toBe(200);
    expect(unicode.json().entries[0].thumbUrl).toContain(
      'path=2026-11-%E6%9D%AD%E5%B7%9E%2F',
    );
  });

  it('rejects traversal, absolute paths, drive letters, NUL bytes and symlink escapes', async () => {
    const paths = [
      '..',
      '../..',
      'sub/../../etc',
      '%2Fetc',
      'C:%5CWindows',
      '..%5C..',
      'sub%00x',
    ];
    for (const traversal of paths) {
      const response = await ctx.app.inject({
        url: `/api/directories?root=root-1&path=${traversal}`,
        headers: auth(),
      });
      expect(response.statusCode, traversal).toBe(403);
      expect(response.json().error.code).toBe('forbidden-path');
    }

    if (symlinkCreated) {
      const symlink = await ctx.app.inject({
        url: '/api/directories?root=root-1&path=link-out',
        headers: auth(),
      });
      expect(symlink.statusCode).toBe(403);
    }

    const missing = await ctx.app.inject({
      url: '/api/directories?root=root-1&path=missing',
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);

    const notDirectory = await ctx.app.inject({
      url: '/api/directories?root=root-1&path=notes.txt',
      headers: auth(),
    });
    expect(notDirectory.statusCode).toBe(400);
    expect(notDirectory.json().error.code).toBe('not-directory');

    const unknownRoot = await ctx.app.inject({
      url: '/api/directories?root=missing',
      headers: auth(),
    });
    expect(unknownRoot.statusCode).toBe(404);

    const imageAsDirectory = await ctx.app.inject({
      url: '/api/directories?root=root-1&path=photo.jpg',
      headers: auth(),
    });
    expect(imageAsDirectory.statusCode).toBe(400);
  });

  it('serves original images with ETag, Range and HEAD support', async () => {
    const file = path.join(ctx.rootDir, 'photo.jpg');
    const stat = await fs.stat(file);
    const url = '/api/images?root=root-1&path=photo.jpg';

    const full = await ctx.app.inject({ url, headers: auth() });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('image/jpeg');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(Number(full.headers['content-length'])).toBe(stat.size);
    expect(full.rawPayload.length).toBe(stat.size);
    const etag = String(full.headers.etag);
    expect(etag).toBeTruthy();

    const notModified = await ctx.app.inject({
      url,
      headers: { ...auth(), 'if-none-match': etag },
    });
    expect(notModified.statusCode).toBe(304);

    const range = await ctx.app.inject({
      url,
      headers: { ...auth(), range: 'bytes=0-9' },
    });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe(`bytes 0-9/${stat.size}`);
    expect(range.headers['content-length']).toBe('10');
    expect(range.rawPayload.length).toBe(10);
    const prefix = await fs.readFile(file);
    expect(range.rawPayload.equals(prefix.subarray(0, 10))).toBe(true);

    const invalidRange = await ctx.app.inject({
      url,
      headers: { ...auth(), range: 'bytes=999999-' },
    });
    expect(invalidRange.statusCode).toBe(416);
    expect(invalidRange.headers['content-range']).toBe(`bytes */${stat.size}`);

    const head = await ctx.app.inject({ method: 'HEAD', url, headers: auth() });
    expect(head.statusCode).toBe(200);
    expect(Number(head.headers['content-length'])).toBe(stat.size);
    expect(head.rawPayload.length).toBe(0);

    const fake = await ctx.app.inject({
      url: '/api/images?root=root-1&path=fake.jpg',
      headers: auth(),
    });
    expect(fake.statusCode).toBe(415);
    expect(fake.json().error.code).toBe('unsupported-image');

    const directory = await ctx.app.inject({
      url: '/api/images?root=root-1&path=sub',
      headers: auth(),
    });
    expect(directory.statusCode).toBe(404);
  });

  it('generates cached WebP thumbnails', async () => {
    const url = '/api/thumbnails?root=root-1&path=photo.jpg';
    const first = await ctx.app.inject({ url, headers: auth() });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/webp');
    expect(first.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(first.rawPayload.subarray(8, 12).toString('ascii')).toBe('WEBP');
    const etag = String(first.headers.etag);

    const cached = await ctx.app.inject({
      url,
      headers: { ...auth(), 'if-none-match': etag },
    });
    expect(cached.statusCode).toBe(304);

    const entries = await fs.readdir(ctx.config.thumbsDir);
    expect(entries.some((entry) => entry.endsWith('.webp'))).toBe(true);

    const resized = await ctx.app.inject({ url: `${url}&w=64`, headers: auth() });
    expect(resized.statusCode).toBe(200);
    expect(resized.headers['content-type']).toBe('image/webp');

    const fake = await ctx.app.inject({
      url: '/api/thumbnails?root=root-1&path=fake.jpg',
      headers: auth(),
    });
    expect(fake.statusCode).toBe(415);
  });

  it('returns 405 for non-GET/HEAD file and health endpoints', async () => {
    const cases: Array<[string, string]> = [
      ['PUT', '/api/directories?root=root-1'],
      ['POST', '/api/directories?root=root-1'],
      ['DELETE', '/api/images?root=root-1&path=photo.jpg'],
      ['PATCH', '/api/thumbnails?root=root-1&path=photo.jpg'],
      ['POST', '/healthz'],
      ['POST', '/api/session'],
    ];
    for (const [method, url] of cases) {
      const response = await ctx.app.inject({ method: method as 'PUT', url, headers: auth() });
      expect(response.statusCode, `${method} ${url}`).toBe(405);
      expect(response.headers.allow).toBeTruthy();
      expect(response.json().error.code).toBe('method-not-allowed');
    }

    const unauth = await ctx.app.inject({
      method: 'PUT',
      url: '/api/directories?root=root-1',
    });
    expect(unauth.statusCode).toBe(405);
  });

  it('never modifies user files while browsing', async () => {
    const before = await hashTree(ctx.rootDir);

    await ctx.app.inject({ url: '/api/directories?root=root-1', headers: auth() });
    await ctx.app.inject({ url: '/api/directories?root=root-1&path=sub', headers: auth() });
    await ctx.app.inject({ url: '/api/images?root=root-1&path=photo.jpg', headers: auth() });
    await ctx.app.inject({ url: '/api/thumbnails?root=root-1&path=photo.jpg', headers: auth() });
    await ctx.app.inject({
      url: '/api/directories?root=root-1&path=2026-11-%E6%9D%AD%E5%B7%9E',
      headers: auth(),
    });

    const after = await hashTree(ctx.rootDir);
    expect(after).toBe(before);
  });

  it('rejects oversized login bodies', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { password: 'x'.repeat(9000) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('bad-request');
  });

  it('returns 401 after the session is revoked', async () => {
    const session = await ctx.sessionStore.create();
    const temporaryCookie = `mfb_session=${session.token}`;
    const ok = await ctx.app.inject({
      url: '/api/roots',
      headers: { cookie: temporaryCookie },
    });
    expect(ok.statusCode).toBe(200);
    await ctx.sessionStore.delete(session.token);
    const revoked = await ctx.app.inject({
      url: '/api/roots',
      headers: { cookie: temporaryCookie },
    });
    expect(revoked.statusCode).toBe(401);
  });
});

describe('password login', () => {
  let ctx: TestContext;
  const clock = fakeClock();

  beforeAll(async () => {
    ctx = await createTestContext({ password: 'correct horse battery staple', now: clock.now });
    await writeJpeg(path.join(ctx.rootDir, 'photo.jpg'));
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('advertises password login and rejects wrong passwords', async () => {
    const session = await ctx.app.inject({ url: '/api/session' });
    expect(session.json()).toMatchObject({
      authenticated: false,
      passwordConfigured: true,
      pairingAvailable: true,
    });

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { password: 'not the password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid-credentials');
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('logs in, rotates the session id and allows logout', async () => {
    // The failed login above applies a short retry backoff.
    clock.advance(2_000);
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { password: 'correct horse battery staple' },
    });
    expect(first.statusCode).toBe(204);
    const firstCookieValue = firstCookie(first.headers['set-cookie']);
    expect(firstCookieValue).toContain('mfb_session=');

    const session = await ctx.app.inject({
      url: '/api/session',
      headers: { cookie: firstCookieValue },
    });
    expect(session.json().authenticated).toBe(true);

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { password: 'correct horse battery staple' },
      headers: { cookie: firstCookieValue },
    });
    expect(second.statusCode).toBe(204);
    const secondCookieValue = firstCookie(second.headers['set-cookie']);
    expect(secondCookieValue).not.toBe(firstCookieValue);

    const oldSession = await ctx.app.inject({
      url: '/api/roots',
      headers: { cookie: firstCookieValue },
    });
    expect(oldSession.statusCode).toBe(401);

    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/session/logout',
      headers: { cookie: secondCookieValue },
    });
    expect(logout.statusCode).toBe(204);
    const afterLogout = await ctx.app.inject({
      url: '/api/roots',
      headers: { cookie: secondCookieValue },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('throttles repeated bad passwords with 429 and Retry-After', async () => {
    let sawRateLimit = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/session/login',
        payload: { password: `wrong password ${attempt}` },
      });
      if (response.statusCode === 429) {
        sawRateLimit = true;
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
        break;
      }
      expect(response.statusCode).toBe(401);
    }
    expect(sawRateLimit).toBe(true);
  });
});

describe('remote mode hardening', () => {
  let ctx: TestContext;
  let cookie: string;

  beforeAll(async () => {
    ctx = await createTestContext({
      password: 'correct horse battery staple',
      publicUrl: 'https://files.example.com',
      extraArgs: ['--trusted-host', 'files.internal'],
    });
    await writeJpeg(path.join(ctx.rootDir, 'photo.jpg'));
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { password: 'correct horse battery staple' },
      headers: { host: 'files.example.com', origin: 'https://files.example.com' },
    });
    expect(login.statusCode).toBe(204);
    cookie = firstCookie(login.headers['set-cookie']);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('accepts the configured public host and trusted hosts, rejecting others', async () => {
    const publicHost = await ctx.app.inject({
      url: '/api/session',
      headers: { host: 'files.example.com' },
    });
    expect(publicHost.statusCode).toBe(200);

    const trusted = await ctx.app.inject({
      url: '/api/session',
      headers: { host: 'files.internal' },
    });
    expect(trusted.statusCode).toBe(200);

    const loopback = await ctx.app.inject({
      url: '/api/session',
      headers: { host: '127.0.0.1:8787' },
    });
    expect(loopback.statusCode).toBe(200);

    const evil = await ctx.app.inject({
      url: '/api/session',
      headers: { host: 'evil.example.com' },
    });
    expect(evil.statusCode).toBe(403);
  });

  it('sets Secure cookies and HSTS in remote mode', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { password: 'correct horse battery staple' },
      headers: { host: 'files.example.com', origin: 'https://files.example.com' },
    });
    const setCookie = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'][0]
      : response.headers['set-cookie'];
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(response.headers['strict-transport-security']).toBe('max-age=15552000');
  });

  it('rejects cross-site origins but allows the configured origin', async () => {
    const evil = await ctx.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { password: 'correct horse battery staple' },
      headers: { host: 'files.example.com', origin: 'https://evil.example.com' },
    });
    expect(evil.statusCode).toBe(403);

    const nullOrigin = await ctx.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { password: 'correct horse battery staple' },
      headers: { host: 'files.example.com', origin: 'null' },
    });
    expect(nullOrigin.statusCode).toBe(403);

    const missingOrigin = await ctx.app.inject({
      method: 'POST',
      url: '/api/session/login',
      payload: { password: 'correct horse battery staple' },
      headers: { host: 'files.example.com' },
    });
    expect(missingOrigin.statusCode).toBe(204);
  });

  it('serves protected files with the remote cookie', async () => {
    const response = await ctx.app.inject({
      url: '/api/directories?root=root-1',
      headers: { cookie, host: 'files.example.com' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['strict-transport-security']).toBe('max-age=15552000');
  });
});

describe('pairing and directory limits', () => {
  it('rate limits repeated bad pairing attempts', async () => {
    const ctx = await createTestContext();
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await ctx.app.inject({
          method: 'POST',
          url: '/api/session/pair',
          payload: { token: 'wrong' },
        });
        expect(response.statusCode).toBe(401);
      }
      const blocked = await ctx.app.inject({
        method: 'POST',
        url: '/api/session/pair',
        payload: { token: 'wrong' },
      });
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }
  });

  it('truncates directories at maxEntries', async () => {
    const ctx = await createTestContext({ maxEntries: 3 });
    try {
      await writeJpeg(path.join(ctx.rootDir, 'a.jpg'));
      await writeJpeg(path.join(ctx.rootDir, 'b.jpg'));
      await writeJpeg(path.join(ctx.rootDir, 'c.jpg'));
      await writeJpeg(path.join(ctx.rootDir, 'd.jpg'));
      const cookie = await ctx.pairCookie();
      const response = await ctx.app.inject({
        url: '/api/directories?root=root-1',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().entries).toHaveLength(3);
      expect(response.json().truncated).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});

describe('session persistence', () => {
  it('keeps sessions across a restart and revokes them on reset', async () => {
    const first = await createTestContext();
    const cookie = await first.pairCookie();
    const originalApp = first.app;
    await originalApp.close();

    try {
      const passwordStore = new PasswordStore(first.dataDir);
      await passwordStore.load();
      const sessionStore = new SessionStore(first.dataDir, first.config.sessionTtlMs);
      await sessionStore.load();
      const guard = new PathGuard(first.config.roots);
      const thumbnails = new ThumbnailService({
        guard,
        cacheDir: first.config.thumbsDir,
        maxWidth: first.config.thumbWidth,
        maxImagePixels: first.config.maxImagePixels,
        maxCacheBytes: first.config.thumbsMaxSizeBytes,
        concurrency: 1,
      });
      const second = await createApp({
        config: first.config,
        passwordStore,
        sessionStore,
        pairing: new PairingToken(first.config.pairingTtlMs),
        loginDelayMs: 0,
        thumbnails,
      });
      const persisted = await second.inject({
        url: '/api/roots',
        headers: { cookie },
      });
      expect(persisted.statusCode).toBe(200);

      await sessionStore.deleteAll();
      const revoked = await second.inject({
        url: '/api/roots',
        headers: { cookie },
      });
      expect(revoked.statusCode).toBe(401);
      await second.close();
    } finally {
      await removeTempDir(first.baseDir);
    }
  });
});

async function hashTree(dir: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        hash.update(`L:${childRelative}\n`);
        continue;
      }
      const stat = await fs.lstat(absolute);
      hash.update(`${childRelative}:${stat.size}:${stat.mtimeMs}\n`);
      if (entry.isFile()) hash.update(await fs.readFile(absolute));
      else if (entry.isDirectory()) await walk(absolute, childRelative);
    }
  }
  await walk(dir, '');
  return hash.digest('hex');
}
