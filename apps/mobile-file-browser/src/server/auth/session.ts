import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { readJsonFile, writeFileAtomic } from '../util/fs';

const SESSION_BYTES = 32;

interface StoredSession {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

interface SessionsFile {
  version: 1;
  sessions: StoredSession[];
}

export interface CreatedSession {
  token: string;
  expiresAt: number;
}

/**
 * Cookie sessions persisted to a 0600 JSON file. The cookie carries a random
 * token; the file stores only SHA-256 hashes so a leaked state file cannot be
 * replayed as a session.
 */
export class SessionStore {
  private readonly file: string;
  private readonly sessions = new Map<string, StoredSession>();
  private loaded = false;

  constructor(
    dataDir: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(dataDir, 'sessions.json');
  }

  async load(): Promise<void> {
    const parsed = await readJsonFile<SessionsFile>(this.file);
    this.sessions.clear();
    if (parsed && parsed.version === 1 && Array.isArray(parsed.sessions)) {
      const current = this.now();
      for (const session of parsed.sessions) {
        if (
          session &&
          typeof session.tokenHash === 'string' &&
          typeof session.expiresAt === 'number' &&
          session.expiresAt > current
        ) {
          this.sessions.set(session.tokenHash, session);
        }
      }
      if (this.sessions.size !== parsed.sessions.length) await this.persist();
    }
    this.loaded = true;
  }

  async create(): Promise<CreatedSession> {
    this.assertLoaded();
    const now = this.now();
    this.pruneExpired(now);
    const token = randomBytes(SESSION_BYTES).toString('base64url');
    const session: StoredSession = {
      tokenHash: hashSessionToken(token),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(session.tokenHash, session);
    await this.persist();
    return { token, expiresAt: session.expiresAt };
  }

  validate(token: string | undefined | null): StoredSession | null {
    if (!token) return null;
    const session = this.sessions.get(hashSessionToken(token));
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(session.tokenHash);
      return null;
    }
    return session;
  }

  async delete(token: string | undefined | null): Promise<void> {
    if (!token) return;
    const key = hashSessionToken(token);
    if (this.sessions.delete(key)) await this.persist();
  }

  async deleteAll(): Promise<void> {
    this.sessions.clear();
    await this.persist();
  }

  size(): number {
    return this.sessions.size;
  }

  private pruneExpired(now: number): void {
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }

  private async persist(): Promise<void> {
    const payload: SessionsFile = {
      version: 1,
      sessions: [...this.sessions.values()],
    };
    await writeFileAtomic(this.file, `${JSON.stringify(payload)}\n`, 0o600);
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('SessionStore.load() was not awaited');
  }
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export const SESSION_COOKIE_NAME = 'mfb_session';
