import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 10 * 60_000;

/**
 * A one-time pairing token generated at startup. Only its hash is retained
 * after construction; the raw token is printed in the terminal URL.
 */
export class PairingToken {
  private readonly hash: Buffer;
  private readonly expiresAt: number;
  private used = false;
  readonly token: string;

  constructor(ttlMs = TOKEN_TTL_MS, now = Date.now()) {
    this.token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.hash = hashToken(this.token);
    this.expiresAt = now + ttlMs;
  }

  available(now = Date.now()): boolean {
    return !this.used && now < this.expiresAt;
  }

  expiresAtDate(): Date {
    return new Date(this.expiresAt);
  }

  /** Consume the token; true only for the first valid presentation. */
  consume(candidate: string, now = Date.now()): boolean {
    if (this.used || now >= this.expiresAt) return false;
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    const candidateHash = hashToken(candidate);
    if (candidateHash.length !== this.hash.length) return false;
    if (!timingSafeEqual(candidateHash, this.hash)) return false;
    this.used = true;
    return true;
  }
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
