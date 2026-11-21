interface LoginIpState {
  /** Failure timestamps within the global 1 hour window. */
  failures: number[];
  consecutive: number;
  lockedUntil: number;
  nextAllowedAt: number;
}

export interface RateCheck {
  ok: boolean;
  retryAfterSeconds: number;
}

const OK: RateCheck = { ok: true, retryAfterSeconds: 0 };
const ONE_HOUR = 3_600_000;
const ONE_MINUTE = 60_000;
const TEN_MINUTES = 10 * ONE_MINUTE;
const PER_IP_PER_MINUTE = 5;
const GLOBAL_PER_HOUR = 20;
const LOCK_MS = 15 * ONE_MINUTE;

/**
 * Login throttling: per-IP failures per minute, global failures per hour,
 * exponential backoff between attempts, and a 15 minute lock after repeated
 * consecutive failures.
 */
export class LoginLimiter {
  private readonly perIp = new Map<string, LoginIpState>();
  private readonly globalFailures: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  check(ip: string): RateCheck {
    const now = this.now();
    this.pruneGlobal(now);
    const state = this.perIp.get(ip);

    if (state?.lockedUntil && state.lockedUntil > now) {
      return { ok: false, retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000) };
    }
    if (state?.nextAllowedAt && state.nextAllowedAt > now) {
      return { ok: false, retryAfterSeconds: Math.ceil((state.nextAllowedAt - now) / 1000) };
    }
    if (state) {
      state.failures = state.failures.filter((at) => at > now - ONE_MINUTE);
      if (state.failures.length >= PER_IP_PER_MINUTE) {
        state.lockedUntil = now + LOCK_MS;
        return { ok: false, retryAfterSeconds: Math.ceil(LOCK_MS / 1000) };
      }
    }
    if (this.globalFailures.length >= GLOBAL_PER_HOUR) {
      const oldest = this.globalFailures[0];
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + ONE_HOUR - now) / 1000)),
      };
    }
    return OK;
  }

  fail(ip: string): void {
    const now = this.now();
    let state = this.perIp.get(ip);
    if (!state) {
      state = { failures: [], consecutive: 0, lockedUntil: 0, nextAllowedAt: 0 };
      this.perIp.set(ip, state);
    }
    state.failures = state.failures.filter((at) => at > now - ONE_HOUR);
    state.failures.push(now);
    state.consecutive += 1;
    if (state.consecutive >= PER_IP_PER_MINUTE) {
      state.lockedUntil = now + LOCK_MS;
    } else {
      const backoff = Math.min(60, 2 ** (state.consecutive - 1));
      state.nextAllowedAt = now + backoff * 1000;
    }
    this.globalFailures.push(now);
    this.pruneGlobal(now);
  }

  success(ip: string): void {
    this.perIp.delete(ip);
  }

  private pruneGlobal(now: number): void {
    while (this.globalFailures.length > 0 && this.globalFailures[0] <= now - ONE_HOUR) {
      this.globalFailures.shift();
    }
  }
}

/** Pairing failures are limited per IP, without a global lock. */
export class PairingLimiter {
  private readonly perIp = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limit = 10,
    private readonly windowMs = TEN_MINUTES,
  ) {}

  check(ip: string): RateCheck {
    const now = this.now();
    const failures = (this.perIp.get(ip) ?? []).filter((at) => at > now - this.windowMs);
    this.perIp.set(ip, failures);
    if (failures.length >= this.limit) {
      const retryAfter = Math.max(1, Math.ceil((failures[0] + this.windowMs - now) / 1000));
      return { ok: false, retryAfterSeconds: retryAfter };
    }
    return OK;
  }

  fail(ip: string): void {
    const now = this.now();
    const failures = (this.perIp.get(ip) ?? []).filter((at) => at > now - this.windowMs);
    failures.push(now);
    this.perIp.set(ip, failures);
  }

  success(ip: string): void {
    this.perIp.delete(ip);
  }
}

