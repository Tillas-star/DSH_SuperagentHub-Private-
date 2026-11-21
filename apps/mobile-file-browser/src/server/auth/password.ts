import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic, ensurePrivateDir, readJsonFile } from '../util/fs';
import { UsageError } from '../config';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT_PARAMS = { N: 32_768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
export const MIN_PASSWORD_LENGTH = 12;

interface PasswordFile {
  version: 1;
  algorithm: 'scrypt';
  params: { N: number; r: number; p: number; keylen: number };
  salt: string;
  hash: string;
}

export class PasswordStore {
  private readonly file: string;
  private record: PasswordFile | null = null;
  private loaded = false;

  constructor(private readonly dataDir: string) {
    this.file = path.join(dataDir, 'password.json');
  }

  async load(): Promise<void> {
    const parsed = await readJsonFile<PasswordFile>(this.file);
    this.record = parsed && parsed.version === 1 && parsed.algorithm === 'scrypt' ? parsed : null;
    this.loaded = true;
  }

  hasPassword(): boolean {
    if (!this.loaded) throw new Error('PasswordStore.load() was not awaited');
    return this.record !== null;
  }

  async setPassword(password: string): Promise<void> {
    validatePassword(password);
    const salt = randomBytes(SALT_LENGTH);
    const hash = await scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
    const record: PasswordFile = {
      version: 1,
      algorithm: 'scrypt',
      params: { ...SCRYPT_PARAMS, keylen: KEY_LENGTH },
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
    };
    await ensurePrivateDir(this.dataDir);
    await writeFileAtomic(this.file, `${JSON.stringify(record, null, 2)}\n`, 0o600);
    this.record = record;
    this.loaded = true;
  }

  async verify(password: string): Promise<boolean> {
    if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
      // Still spend a comparable amount of time to reduce timing signal.
      await scrypt('x', 'x', KEY_LENGTH, SCRYPT_PARAMS).catch(() => undefined);
      return false;
    }
    const record = this.record;
    if (!record) {
      await scrypt('x', 'x', KEY_LENGTH, SCRYPT_PARAMS).catch(() => undefined);
      return false;
    }
    let expected: Buffer;
    let actual: Buffer;
    try {
      expected = Buffer.from(record.hash, 'base64');
      const salt = Buffer.from(record.salt, 'base64');
      actual = await scrypt(password, salt, record.params.keylen ?? KEY_LENGTH, {
        N: record.params.N,
        r: record.params.r,
        p: record.params.p,
        maxmem: SCRYPT_PARAMS.maxmem,
      });
    } catch {
      return false;
    }
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}

export function validatePassword(password: string): void {
  if (typeof password !== 'string') {
    throw new UsageError('密码必须是字符串');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UsageError(`访问密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
  }
  if (password.length > 1024) {
    throw new UsageError('访问密码过长');
  }
}
