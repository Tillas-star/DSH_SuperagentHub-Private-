import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/server/config';
import { RemotePolicy } from '../../src/server/remote';

const config = {
  mode: 'remote',
  publicUrl: new URL('https://files.example.com'),
  trustedHosts: ['files.internal', 'files.internal:8443'],
  tlsCert: undefined,
} as AppConfig;

function request(
  remoteAddress: string,
  headers: Record<string, string> = {},
): FastifyRequest {
  return {
    socket: { remoteAddress },
    headers,
  } as unknown as FastifyRequest;
}

describe('RemotePolicy', () => {
  const policy = new RemotePolicy(config);

  it('trusts forwarded headers only from loopback', () => {
    const loopback = request('127.0.0.1', {
      'x-forwarded-for': '9.9.9.9, 10.0.0.1',
      'x-forwarded-proto': 'https',
    });
    expect(policy.clientIp(loopback)).toBe('9.9.9.9');
    expect(policy.isSecure(loopback)).toBe(true);

    const external = request('203.0.113.10', {
      'x-forwarded-for': '9.9.9.9',
      'x-forwarded-proto': 'https',
    });
    expect(policy.clientIp(external)).toBe('203.0.113.10');
    expect(policy.isSecure(external)).toBe(true);
  });

  it('is always secure when a public URL is configured', () => {
    const local = request('127.0.0.1');
    expect(policy.isSecure(local)).toBe(true);
  });

  it('allows the public host, trusted hosts and loopback', () => {
    expect(policy.isAllowedHost('files.example.com')).toBe(true);
    expect(policy.isAllowedHost('files.example.com:443')).toBe(true);
    expect(policy.isAllowedHost('files.internal')).toBe(true);
    expect(policy.isAllowedHost('files.internal:8443')).toBe(true);
    expect(policy.isAllowedHost('127.0.0.1:8787')).toBe(true);
    expect(policy.isAllowedHost('localhost:8787')).toBe(true);
  });

  it('rejects unknown hosts, wrong ports and malformed host headers', () => {
    expect(policy.isAllowedHost('evil.example.com')).toBe(false);
    expect(policy.isAllowedHost('files.example.com:8443')).toBe(false);
    expect(policy.isAllowedHost('files.internal/path')).toBe(false);
    expect(policy.isAllowedHost('')).toBe(false);
  });
});
