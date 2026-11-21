import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordStore, validatePassword } from '../../src/server/auth/password';
import { PairingToken } from '../../src/server/auth/pairing';
import { LoginLimiter, PairingLimiter } from '../../src/server/auth/rate-limit';
import { SessionStore } from '../../src/server/auth/session';
import { fakeClock } from '../support/context';
import { removeTempDir } from '../support/cleanup';

describe('PasswordStore', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfb-password-'));
  });
  afterAll(async () => {
    await removeTempDir(dir);
  });

  it('hashes, verifies and never stores the plaintext', async () => {
    const store = new PasswordStore(dir);
    await store.load();
    expect(store.hasPassword()).toBe(false);
    await store.setPassword('correct horse battery staple');
    expect(store.hasPassword()).toBe(true);
    expect(await store.verify('correct horse battery staple')).toBe(true);
    expect(await store.verify('wrong password here')).toBe(false);

    const raw = await fs.readFile(path.join(dir, 'password.json'), 'utf8');
    expect(raw).not.toContain('correct horse battery staple');
    const parsed = JSON.parse(raw) as { algorithm: string; params: { N: number; r: number } };
    expect(parsed.algorithm).toBe('scrypt');
    expect(parsed.params.N).toBe(32768);
    expect(parsed.params.r).toBe(8);

    if (process.platform !== 'win32') {
      const mode = (await fs.stat(path.join(dir, 'password.json'))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('rejects short and oversized passwords', () => {
    expect(() => validatePassword('short')).toThrow();
    expect(() => validatePassword('x'.repeat(1025))).toThrow();
  });
});

describe('PairingToken', () => {
  it('is one-time and expires', () => {
    const clock = fakeClock(1_000_000);
    const pairing = new PairingToken(10_000, clock.now());
    expect(pairing.available(clock.now())).toBe(true);
    expect(pairing.consume('wrong', clock.now())).toBe(false);
    expect(pairing.consume(pairing.token, clock.now())).toBe(true);
    expect(pairing.available(clock.now())).toBe(false);
    expect(pairing.consume(pairing.token, clock.now())).toBe(false);
  });

  it('rejects a token after its ttl', () => {
    const clock = fakeClock(1_000_000);
    const pairing = new PairingToken(10_000, clock.now());
    clock.advance(10_001);
    expect(pairing.available(clock.now())).toBe(false);
    expect(pairing.consume(pairing.token, clock.now())).toBe(false);
  });
});

describe('SessionStore', () => {
  it('creates, validates, persists and expires sessions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfb-session-'));
    const clock = fakeClock(1_000_000);
    try {
      const store = new SessionStore(dir, 60_000, clock.now);
      await store.load();
      const created = await store.create();
      expect(store.validate(created.token)).not.toBeNull();
      expect(store.validate('bogus')).toBeNull();

      const reloaded = new SessionStore(dir, 60_000, clock.now);
      await reloaded.load();
      expect(reloaded.validate(created.token)).not.toBeNull();

      const raw = await fs.readFile(path.join(dir, 'sessions.json'), 'utf8');
      expect(raw).not.toContain(created.token);

      clock.advance(60_001);
      expect(reloaded.validate(created.token)).toBeNull();
    } finally {
      await removeTempDir(dir);
    }
  });

  it('deletes single sessions and all sessions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfb-session-'));
    try {
      const store = new SessionStore(dir, 60_000);
      await store.load();
      const first = await store.create();
      const second = await store.create();
      expect(store.size()).toBe(2);
      await store.delete(first.token);
      expect(store.validate(first.token)).toBeNull();
      expect(store.validate(second.token)).not.toBeNull();
      await store.deleteAll();
      expect(store.validate(second.token)).toBeNull();
      expect(store.size()).toBe(0);
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe('rate limiting', () => {
  it('backs off, locks after repeated login failures and recovers', () => {
    const clock = fakeClock(1_000_000);
    const limiter = new LoginLimiter(clock.now);
    expect(limiter.check('1.2.3.4').ok).toBe(true);
    limiter.fail('1.2.3.4');
    const firstBackoff = limiter.check('1.2.3.4');
    expect(firstBackoff.ok).toBe(false);
    expect(firstBackoff.retryAfterSeconds).toBeGreaterThan(0);

    clock.advance(1_100);
    expect(limiter.check('1.2.3.4').ok).toBe(true);
    limiter.fail('1.2.3.4');
    clock.advance(2_100);
    expect(limiter.check('1.2.3.4').ok).toBe(true);

    for (let index = 0; index < 3; index += 1) {
      limiter.fail('1.2.3.4');
    }
    const locked = limiter.check('1.2.3.4');
    expect(locked.ok).toBe(false);
    clock.advance(15 * 60_000 + 1);
    expect(limiter.check('1.2.3.4').ok).toBe(true);
    limiter.fail('1.2.3.4');
    const afterLock = limiter.check('1.2.3.4');
    expect(afterLock.ok).toBe(false);
    expect(afterLock.retryAfterSeconds).toBeLessThanOrEqual(2);

    clock.advance(2_100);
    limiter.success('1.2.3.4');
    expect(limiter.check('1.2.3.4').ok).toBe(true);
  });

  it('enforces a global hourly failure cap', () => {
    const clock = fakeClock(2_000_000);
    const limiter = new LoginLimiter(clock.now);
    for (let ip = 0; ip < 4; ip += 1) {
      for (let attempt = 0; attempt < 5; attempt += 1) limiter.fail(`10.0.0.${ip}`);
    }
    const blocked = limiter.check('10.0.0.99');
    expect(blocked.ok).toBe(false);
    clock.advance(60 * 60_000 + 1);
    expect(limiter.check('10.0.0.99').ok).toBe(true);
  });

  it('limits pairing failures per window', () => {
    const clock = fakeClock(3_000_000);
    const limiter = new PairingLimiter(clock.now, 3, 10_000);
    expect(limiter.check('5.6.7.8').ok).toBe(true);
    limiter.fail('5.6.7.8');
    limiter.fail('5.6.7.8');
    limiter.fail('5.6.7.8');
    expect(limiter.check('5.6.7.8').ok).toBe(false);
    clock.advance(10_001);
    expect(limiter.check('5.6.7.8').ok).toBe(true);
  });
});
