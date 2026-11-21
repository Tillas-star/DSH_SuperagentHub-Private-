import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from './config';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class RemotePolicy {
  constructor(private readonly config: AppConfig) {}

  isTrustedProxy(request: FastifyRequest): boolean {
    const address = normalizeAddress(request.socket.remoteAddress);
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  clientIp(request: FastifyRequest): string {
    if (this.isTrustedProxy(request)) {
      const forwarded = request.headers['x-forwarded-for'];
      const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      if (value) {
        const first = value.split(',')[0]?.trim();
        if (first && isIP(normalizeAddress(first)) !== 0) return normalizeAddress(first);
      }
    }
    return normalizeAddress(request.socket.remoteAddress) || 'unknown';
  }

  isSecure(request: FastifyRequest): boolean {
    if (this.config.publicUrl || this.config.tlsCert) return true;
    if (this.isTrustedProxy(request)) {
      const proto = request.headers['x-forwarded-proto'];
      const value = Array.isArray(proto) ? proto[0] : proto;
      if (value && value.split(',')[0]?.trim().toLowerCase() === 'https') return true;
    }
    return false;
  }

  /** Validate the Host header. Only enforced in remote mode. */
  checkHost(request: FastifyRequest): boolean {
    if (this.config.mode !== 'remote') return true;
    const host = request.headers.host;
    if (!host || Array.isArray(host)) return false;
    return this.isAllowedHost(host);
  }

  /**
   * Cross-site request protection for state-changing requests. Requests
   * without an Origin header (curl, native apps) are allowed; browsers send
   * Origin for cross-site POSTs.
   */
  checkOrigin(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    if (Array.isArray(origin) || origin === 'null' || !origin) return false;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (this.config.mode === 'remote') {
      // Local loopback access is useful for first-time pairing and debugging
      // even when the public endpoint is HTTPS-only.
      const loopbackOrigin = LOOPBACK_HOSTS.has(parsed.hostname);
      if (parsed.protocol !== 'https:' && !loopbackOrigin) return false;
      return this.isAllowedHost(parsed.host);
    }
    const host = request.headers.host;
    if (!host) return false;
    return parsed.host.toLowerCase() === host.toLowerCase();
  }

  isAllowedHost(hostHeader: string): boolean {
    const request = parseHost(hostHeader);
    if (!request) return false;
    if (LOOPBACK_HOSTS.has(request.hostname)) return true;

    if (this.config.publicUrl) {
      const publicHost = this.config.publicUrl.hostname.toLowerCase();
      if (request.hostname === publicHost) {
        const publicPort = this.config.publicUrl.port;
        if (!publicPort || publicPort === '443') {
          return request.port === '' || request.port === '443';
        }
        return request.port === publicPort;
      }
    }

    for (const trusted of this.config.trustedHosts) {
      const allowed = parseHost(trusted);
      if (!allowed) continue;
      if (allowed.hostname !== request.hostname) continue;
      if (!allowed.port || allowed.port === request.port) return true;
    }
    return false;
  }
}

function parseHost(value: string): { hostname: string; port: string } | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || /[\s/\\]/.test(trimmed)) return null;
  try {
    const url = new URL(`http://${trimmed}`);
    if (!url.hostname) return null;
    return { hostname: url.hostname.toLowerCase(), port: url.port };
  } catch {
    return null;
  }
}

function normalizeAddress(address: string | undefined): string {
  if (!address) return '';
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) return address.slice(7);
  return address;
}
