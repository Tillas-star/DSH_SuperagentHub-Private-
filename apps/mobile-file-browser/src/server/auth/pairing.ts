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
  private tokenValue: string | null;

  constructor(ttlMs = TOKEN_TTL_MS, now = Date.now()) {
    this.tokenValue = randomBytes(TOKEN_BYTES).toString('base64url');
    this.hash = hashToken(this.tokenValue);
    this.expiresAt = now + ttlMs;
  }

  /** The raw token is kept only until it has been printed/handed out. */
  get token(): string {
    if (this.tokenValue === null) throw new Error('pairing token is no longer available');
    return this.tokenValue;
  }

  /** Drop the raw token; the hash and expiry remain for pairing validation. */
  clearToken(): void {
    this.tokenValue = null;
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
    this.tokenValue = null;
    return true;
  }
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
